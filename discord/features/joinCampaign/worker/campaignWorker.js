"use strict";

const discordApi = require("../../../verification/utils/discordAPI");
const oauthTokenManager = require("../../../core/oauthTokenManager");
const { getJoinCampaignConfig } = require("../config");
const { sendBatchLog, sendFinalSummaryEmbed } = require("./batchLogger");
const { getMode } = require("../modes/modeRegistry");
const { streamCandidates } = require("../services/candidateQueryService");
const { buildPanelPayload } = require("../ui/panelBuilder");
const { countEligibleCandidates } = require("../services/candidateQueryService");
const { getLiveTargetMemberIds } = require("../services/preflightService");

function dispatchSystemicAlert({ code, title, description, error, details = {} }) {
    try {
        const { sendWebhookEvent } = require("../../../core/webhooks");
        if (typeof sendWebhookEvent === "function") {
            sendWebhookEvent({
                category: "SYSTEM",
                severity: "CRITICAL",
                actionRequired: true,
                code: code || "join_campaign.systemic_error",
                title: title || "Join Campaign Systemic Error",
                description: description || error?.message || "Join campaign error",
                fields: Object.entries(details).map(([name, value]) => ({
                    name,
                    value: String(value),
                    inline: true
                }))
            });
        }
    } catch (_) {}
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function randomJitter(minMs = 100, maxMs = 500) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

class CampaignWorker {
    constructor() {
        this._activeWorkerPromise = null;
        this._currentJobId = null;
        this._isStopping = false;
        this._wakeUpResolvers = new Set();
    }

    get isRunning() {
        return Boolean(this._activeWorkerPromise);
    }

    get currentJobId() {
        return this._currentJobId;
    }

    stopCurrentWorker() {
        this._isStopping = true;
        for (const wakeUp of this._wakeUpResolvers) {
            try { wakeUp(); } catch (_) {}
        }
        this._wakeUpResolvers.clear();
    }

    _interruptibleSleep(ms) {
        if (this._isStopping || ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            let timer = null;
            const wakeUp = () => {
                if (timer) clearTimeout(timer);
                this._wakeUpResolvers.delete(wakeUp);
                resolve();
            };
            timer = setTimeout(wakeUp, ms);
            this._wakeUpResolvers.add(wakeUp);
        });
    }

    async waitForCompletion() {
        if (this._activeWorkerPromise) {
            await this._activeWorkerPromise;
        }
    }

    async startWorker({
        job,
        client,
        repository,
        tokenManager = oauthTokenManager,
        discord = discordApi,
        targetMemberIds = null,
        config = getJoinCampaignConfig()
    }) {
        if (!config.enabled) {
            throw new Error("Join Campaign subsystem is disabled (JOIN_CAMPAIGN_ENABLED=false)");
        }

        if (this.isRunning) {
            throw new Error("ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ");
        }

        this._currentJobId = job.id;
        this._isStopping = false;
        this._wakeUpResolvers.clear();

        this._activeWorkerPromise = this._executeLoop({
            job,
            client,
            repository,
            tokenManager,
            discord,
            targetMemberIds,
            config
        }).finally(() => {
            this._activeWorkerPromise = null;
            this._currentJobId = null;
        });

        return { ok: true, jobId: job.id, workerPromise: this._activeWorkerPromise };
    }

    async _executeLoop({
        job,
        client,
        repository,
        tokenManager,
        discord,
        targetMemberIds: passedTargetMemberIds = null,
        config
    }) {
        const startTime = job.createdAt || Date.now();
        const mode = getMode(job.mode);
        const targetGuildId = String(job.targetGuildId);
        let targetGuild = client.guilds.cache.get(targetGuildId);
        if (!targetGuild && client.guilds?.fetch) {
            targetGuild = await client.guilds.fetch(targetGuildId).catch(() => null);
        }

        if (!targetGuild) {
            const failClosedMsg = "ไม่พบเซิร์ฟเวอร์ปลายทาง หรือบอทไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมายแล้ว (Fail-Closed)";
            repository.updateJob(job.id, {
                status: "FAILED",
                lastError: failClosedMsg,
                completedAt: Date.now()
            });
            dispatchSystemicAlert({
                code: "join_campaign.target_guild_missing",
                title: "Join Campaign: เซิร์ฟเวอร์ปลายทางไม่พร้อมใช้งาน",
                description: failClosedMsg,
                details: {
                    campaignId: job.id,
                    targetGuildId
                }
            });
            throw new Error(failClosedMsg);
        }

        const targetGuildName = targetGuild.name || job.targetGuildName || targetGuildId;
        const requestedQuota = Number(job.requestedAmount) || 0;

        let joinedCount = Number(job.joinedCount) || 0;
        let alreadyCount = Number(job.alreadyCount) || 0;
        let failedCount = Number(job.failedCount) || 0;
        let processedCount = Number(job.processedCount) || 0;
        let retryCount = Number(job.retryCount) || 0;

        // Distinct retry trackers to avoid 5xx competing with 429 budget
        const rateLimitRetries = new Map();
        const networkRetries = new Map();

        // Bounded adaptive concurrency pool parameters
        const minConcurrency = 1;
        const maxConcurrency = Math.min(32, Math.max(1, Number(config.maxConcurrency || 32)));
        let currentConcurrency = Math.min(maxConcurrency, Math.max(minConcurrency, Number(job.currentConcurrency || 8)));

        let candidateCursor = job.candidateCursor || null;
        let backoffUntil = 0;
        let consecutiveSuccesses = 0;
        let isGuildFull = false;
        let finalStatus = "COMPLETED";
        let statusReason = null;

        const batchBuffer = [];
        let batchIndex = 1;
        let lastPanelUpdateAt = Date.now();

        // 1. Resolve Target Guild membership set (Deduplication cache)
        let targetMemberIds = (passedTargetMemberIds instanceof Set)
            ? passedTargetMemberIds
            : (job.targetMemberIds instanceof Set ? job.targetMemberIds : null);
        if (!targetMemberIds) {
            try {
                targetMemberIds = await getLiveTargetMemberIds(targetGuild);
            } catch (err) {
                const failClosedMsg = "ไม่สามารถตรวจสอบรายชื่อสมาชิกในเซิร์ฟเวอร์เป้าหมายได้ครบถ้วน (Fail-Closed ป้องกันข้อมูลซ้ำซ้อน)";
                repository.updateJob(job.id, {
                    status: "FAILED",
                    lastError: failClosedMsg,
                    completedAt: Date.now()
                });
                throw new Error(failClosedMsg);
            }
        }

        // 2. Seen users tracking across batches
        const completedUserIds = repository.getCompletedUserIds ? repository.getCompletedUserIds(job.id) : new Set();
        const seenUsers = new Set([...completedUserIds]);

        // Helper to update panel debounced
        const updatePanelDebounced = async (force = false) => {
            const now = Date.now();
            if (!force && now - lastPanelUpdateAt < 2500) return;
            lastPanelUpdateAt = now;

            try {
                const panel = repository.findPanelByChannelId
                    ? repository.findPanelByChannelId(job.startedByChannelId)
                    : null;
                if (!panel || !panel.messageId) return;

                const channel = await client.channels.fetch(panel.channelId).catch(() => null);
                if (!channel) return;
                const message = await channel.messages.fetch(panel.messageId).catch(() => null);
                if (!message) return;

                const liveJobPayload = {
                    status: "RUNNING",
                    joinedCount,
                    requestedAmount: requestedQuota,
                    currentConcurrency
                };

                const panelPayload = buildPanelPayload({
                    mode,
                    panelState: panel,
                    readyCount: panel.lastReadyCount,
                    liveJob: liveJobPayload,
                    targetGuildName
                });

                await message.edit(panelPayload).catch(() => {});
            } catch (_) {}
        };

        // 3. Initialize candidate stream generator
        const candidateStream = streamCandidates({
            mode,
            baseConfig: {
                sourceGuildId: job.sourceGuildId,
                targetGuildId: job.targetGuildId
            },
            tokenManager,
            batchSize: Math.max(50, Number(config.batchSize || 200)),
            startCursor: candidateCursor,
            seenUsers
        });

        let streamExhausted = false;

        // Helper: refill SQLite items queue from MongoDB candidate stream if low
        const maybeTopUpQueue = async () => {
            if (streamExhausted) return;
            const pendingCount = repository.countPendingItems ? repository.countPendingItems(job.id) : 0;
            if (pendingCount >= 40) return;

            const itemsToInsert = [];
            while (itemsToInsert.length < 100) {
                const nextItem = await candidateStream.next();
                if (nextItem.done) {
                    streamExhausted = true;
                    break;
                }

                const { candidate, cursor } = nextItem.value || {};
                if (!candidate) continue;

                const userId = String(candidate.userId || candidate.discord?.userId || "").trim();
                if (!userId || seenUsers.has(userId)) continue;
                seenUsers.add(userId);

                if (cursor) candidateCursor = cursor;

                itemsToInsert.push({
                    userId,
                    tokenField: candidate.tokenField || "oauth"
                });
            }

            if (itemsToInsert.length > 0) {
                repository.createItems(job.id, itemsToInsert);
                repository.updateJob(job.id, { candidateCursor });
            }
        };

        try {
            // Preload initial queue batch
            await maybeTopUpQueue();

            const activeTasks = new Set();
            let inFlightJoins = 0;

            // Main adaptive concurrency loop with strict quota reservation
            while (!this._isStopping && joinedCount < requestedQuota) {
                if (isGuildFull) {
                    finalStatus = "SERVER_FULL";
                    statusReason = "เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว";
                    break;
                }

                // Check rate-limit backoff
                const now = Date.now();
                if (now < backoffUntil) {
                    await this._interruptibleSleep(backoffUntil - now);
                    continue;
                }

                // Top up queue if needed
                await maybeTopUpQueue();

                // Quota reservation: ensure in-flight + joined never exceeds requested quota
                const remainingSlots = requestedQuota - (joinedCount + inFlightJoins);
                if (remainingSlots <= 0 || activeTasks.size >= currentConcurrency) {
                    await Promise.race(activeTasks);
                    continue;
                }

                const item = repository.claimNextPendingItem(job.id, 35000);
                if (!item) {
                    if (activeTasks.size > 0) {
                        await Promise.race(activeTasks);
                        continue;
                    }
                    if (streamExhausted && (repository.countPendingItems ? repository.countPendingItems(job.id) === 0 : true)) {
                        // Candidate pool is exhausted before meeting target quota
                        finalStatus = joinedCount > 0 ? "PARTIAL" : "FAILED";
                        if (joinedCount === 0 && !statusReason) {
                            statusReason = "ไม่สามารถดึงสมาชิกเข้าเซิร์ฟเวอร์ได้ตามเป้าหมาย (ไม่มีสมาชิกที่พร้อมดึงหรือเกิดข้อผิดพลาด)";
                        }
                        break;
                    }
                    await this._interruptibleSleep(200);
                    continue;
                }

                // Reserve in-flight join slot
                inFlightJoins++;

                // Launch worker task concurrently
                const taskPromise = (async () => {
                    try {
                        const userId = item.userId;
                        // processedCount reflects distinct candidate users processed
                        if (Number(item.attempts || 0) === 0) {
                            processedCount++;
                        }

                        // STEP 1: Pre-filter against current Target Membership
                        if (targetMemberIds.has(userId)) {
                            alreadyCount++;
                            repository.updateItemStatus(job.id, userId, "already_member");
                            batchBuffer.push({ userId, status: "already_member" });
                            return;
                        }

                        // Quota safeguard before executing external work
                        if (joinedCount >= requestedQuota) {
                            repository.updateItemStatus(job.id, userId, "pending");
                            return;
                        }

                        // STEP 2: JIT Token Retrieval & Refresh
                        const tokenResult = await tokenManager.getAccessToken({
                            userId,
                            tokenField: item.tokenField || "oauth",
                            env: process.env
                        });

                        const accessToken = tokenResult?.accessToken;
                        if (!accessToken) {
                            failedCount++;
                            repository.updateItemStatus(job.id, userId, "failed", "token_unavailable");
                            batchBuffer.push({ userId, status: "failed" });
                            return;
                        }

                        // Final check on quota before calling Discord API
                        if (joinedCount >= requestedQuota) {
                            repository.updateItemStatus(job.id, userId, "pending");
                            return;
                        }

                        // STEP 3: Call Discord REST API with callerManagedRetry so worker owns backoff
                        let res;
                        try {
                            res = await discord.addMemberToGuild(targetGuildId, userId, accessToken, { callerManagedRetry: true });
                        } catch (err) {
                            res = { ok: false, status: 500, error: err };
                        }

                        // STEP 4: Handle response & adapt concurrency
                        const status = res?.status;
                        const discordCode = res?.error?.code ?? res?.code;

                        if (res?.ok || status === 201) {
                            if (joinedCount < requestedQuota) {
                                joinedCount++;
                                targetMemberIds.add(userId);
                                repository.updateItemStatus(job.id, userId, "joined");
                                batchBuffer.push({ userId, status: "joined" });
                            } else {
                                targetMemberIds.add(userId);
                                repository.updateItemStatus(job.id, userId, "joined");
                            }

                            // Adaptive ramp-up on consecutive successes
                            consecutiveSuccesses++;
                            if (consecutiveSuccesses >= 4 && currentConcurrency < maxConcurrency) {
                                currentConcurrency = Math.min(maxConcurrency, currentConcurrency + 1);
                                consecutiveSuccesses = 0;
                            }
                        } else if (status === 204) {
                            alreadyCount++;
                            targetMemberIds.add(userId);
                            repository.updateItemStatus(job.id, userId, "already_member");
                            batchBuffer.push({ userId, status: "already_member" });
                        } else if (status === 429) {
                            // Rate Limited: scale down concurrency & back off
                            retryCount++;
                            consecutiveSuccesses = 0;
                            currentConcurrency = Math.max(minConcurrency, Math.floor(currentConcurrency / 2));

                            const maxRateLimitRetries = Number(config.maxRateLimitRetries || 3);
                            const currentRlRetries = (rateLimitRetries.get(userId) || 0) + 1;
                            rateLimitRetries.set(userId, currentRlRetries);

                            if (currentRlRetries <= maxRateLimitRetries) {
                                const explicitRetry = Number(res?.retryAfter);
                                const retryAfterMs = Number.isFinite(explicitRetry) && explicitRetry > 0
                                    ? explicitRetry
                                    : 2500;
                                const backoffDelay = retryAfterMs + randomJitter(50, 150);

                                backoffUntil = Date.now() + backoffDelay;

                                // Re-queue item for retry with backoff delay
                                repository.incrementItemAttempt(job.id, userId, "rate_limited", backoffDelay);
                            } else {
                                failedCount++;
                                repository.updateItemStatus(job.id, userId, "failed", "rate_limit_retries_exceeded");
                                batchBuffer.push({ userId, status: "failed" });
                            }
                        } else if (status >= 500 || status === 0) {
                            // Server / Network Transient Error
                            retryCount++;
                            consecutiveSuccesses = 0;
                            currentConcurrency = Math.max(minConcurrency, currentConcurrency - 1);

                            const currentNetRetries = (networkRetries.get(userId) || 0) + 1;
                            networkRetries.set(userId, currentNetRetries);

                            if (currentNetRetries <= 2) {
                                const delay = Math.min(1000 * Math.pow(2, currentNetRetries), 12000) + randomJitter(50, 200);
                                repository.incrementItemAttempt(job.id, userId, "network_error", delay);
                            } else {
                                failedCount++;
                                repository.updateItemStatus(job.id, userId, "failed", "network_retries_exceeded");
                                batchBuffer.push({ userId, status: "failed" });
                            }
                        } else {
                            // 4xx Permanent Errors
                            consecutiveSuccesses = 0;

                            if (discordCode === 30005) {
                                // Target Guild member limit reached (Max guild members)
                                isGuildFull = true;
                                failedCount++;
                                repository.updateItemStatus(job.id, userId, "failed", "guild_full");
                                batchBuffer.push({ userId, status: "guild_full" });
                                return;
                            }

                            failedCount++;
                            const errReason = res?.error?.message || (discordCode ? `error_${discordCode}` : `http_${status}`);
                            repository.updateItemStatus(job.id, userId, "failed", errReason);
                            batchBuffer.push({ userId, status: "failed" });
                        }

                        // STEP 5: Batch Logging every progressEvery items
                        if (batchBuffer.length >= config.progressEvery) {
                            const batchItems = batchBuffer.splice(0, config.progressEvery);
                            const bJoined = batchItems.filter(i => i.status === "joined").length;
                            const bAlready = batchItems.filter(i => i.status === "already_member").length;
                            const bFailed = batchItems.filter(i => i.status === "failed" || i.status === "guild_full").length;

                            await sendBatchLog({
                                webhookUrl: job.webhookUrl,
                                mode,
                                batchNumber: batchIndex++,
                                items: batchItems,
                                joinedCount: bJoined,
                                alreadyCount: bAlready,
                                failedCount: bFailed,
                                targetGuildName
                            });
                        }

                        // STEP 6: Checkpoint with throughput to SQLite
                        const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
                        const currentThroughput = Number((joinedCount / elapsedSeconds).toFixed(2));

                        repository.updateJob(job.id, {
                            joinedCount,
                            alreadyCount,
                            failedCount,
                            processedCount,
                            retryCount,
                            currentConcurrency,
                            currentThroughput,
                            candidateCursor
                        });

                        // STEP 7: Panel update debounced
                        await updatePanelDebounced(false);
                    } catch (taskErr) {
                        console.error(`[JoinCampaign] Task execution error for user ${item.userId}:`, taskErr?.message);
                        failedCount++;
                        try {
                            repository.updateItemStatus(job.id, item.userId, "failed", taskErr?.message || "task_error");
                        } catch (_) {}
                    } finally {
                        inFlightJoins--;
                    }
                })();

                activeTasks.add(taskPromise);
                taskPromise.then(
                    () => activeTasks.delete(taskPromise),
                    () => activeTasks.delete(taskPromise)
                );

                // Microtask yield instead of artificial 50ms throttle
                await new Promise(resolve => setImmediate(resolve));
            }

            // Await any remaining active concurrent tasks
            if (activeTasks.size > 0) {
                await Promise.allSettled(Array.from(activeTasks));
            }

            // Flush remaining batch logs
            if (batchBuffer.length > 0) {
                const bJoined = batchBuffer.filter(i => i.status === "joined").length;
                const bAlready = batchBuffer.filter(i => i.status === "already_member").length;
                const bFailed = batchBuffer.filter(i => i.status === "failed" || i.status === "guild_full").length;

                await sendBatchLog({
                    webhookUrl: job.webhookUrl,
                    mode,
                    batchNumber: batchIndex++,
                    items: batchBuffer,
                    joinedCount: bJoined,
                    alreadyCount: bAlready,
                    failedCount: bFailed,
                    targetGuildName
                });
            }

            if (this._isStopping) {
                finalStatus = "INTERRUPTED";
                statusReason = "หยุดการทำงานชั่วคราวเนื่องจากบอทปิดระบบ (Graceful Shutdown) พร้อมกลับมาทำงานต่อเมื่อระบบเริ่มใหม่";
            } else if (joinedCount >= requestedQuota && requestedQuota > 0) {
                finalStatus = "COMPLETED";
                statusReason = null;
            } else if (isGuildFull) {
                finalStatus = "SERVER_FULL";
                statusReason = "เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว";
            } else if (joinedCount > 0) {
                finalStatus = "PARTIAL";
                statusReason = "สมาชิกที่พร้อมดึงในระบบหมดแล้วก่อนถึงเป้าหมาย";
            } else {
                finalStatus = "FAILED";
                if (!statusReason) {
                    statusReason = "ไม่สามารถดึงสมาชิกเข้าเซิร์ฟเวอร์ได้ตามเป้าหมาย (ไม่มีสมาชิกที่พร้อมดึงหรือเกิดข้อผิดพลาด)";
                }
            }

        } catch (err) {
            finalStatus = "FAILED";
            statusReason = err.message || "เกิดข้อผิดพลาดในการประมวลผล";
            const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
            repository.updateJob(job.id, {
                status: "FAILED",
                lastError: statusReason,
                joinedCount,
                alreadyCount,
                failedCount,
                processedCount,
                retryCount,
                currentThroughput: Number((joinedCount / elapsedSeconds).toFixed(2)),
                completedAt: Date.now()
            });
            dispatchSystemicAlert({
                code: "join_campaign.worker_crash",
                title: "Join Campaign: การประมวลผลล้มเหลว",
                description: statusReason,
                details: {
                    campaignId: job.id,
                    joinedCount,
                    requestedQuota
                }
            });
            throw err;
        } finally {
            const completedAt = Date.now();
            const durationMs = completedAt - startTime;
            const elapsedSeconds = Math.max(1, durationMs / 1000);
            const currentThroughput = Number((joinedCount / elapsedSeconds).toFixed(2));
            const isInterrupted = finalStatus === "INTERRUPTED";
            const completedTimestamp = isInterrupted ? null : completedAt;

            // Release any stale leases
            if (repository.releaseExpiredLeases) {
                repository.releaseExpiredLeases(job.id);
            }

            // Checkpoint final state to SQLite
            repository.updateJob(job.id, {
                status: finalStatus,
                lastError: statusReason,
                joinedCount,
                alreadyCount,
                failedCount,
                processedCount,
                retryCount,
                currentConcurrency,
                currentThroughput,
                candidateCursor,
                completedAt: completedTimestamp
            });

            // ALWAYS send Final Summary Webhook regardless of success or failure
            try {
                await sendFinalSummaryEmbed({
                    webhookUrl: job.webhookUrl,
                    mode,
                    targetGuildName,
                    targetGuildId,
                    sourceGuildName: job.sourceGuildName,
                    sourceGuildId: job.sourceGuildId,
                    requestedQuota,
                    joinedCount,
                    alreadyCount,
                    failedCount,
                    processedCount,
                    retryCount,
                    durationMs,
                    finalStatus,
                    statusReason
                });
            } catch (_) {}

            // Update panel message in channel to final idle state
            try {
                await this._finishPanelUpdate({
                    job,
                    client,
                    repository,
                    mode,
                    joinedCount,
                    alreadyCount,
                    failedCount,
                    finalStatus,
                    targetGuildName,
                    tokenManager
                });
            } catch (_) {}
        }
    }

    async _finishPanelUpdate({
        job,
        client,
        repository,
        mode,
        joinedCount,
        alreadyCount,
        failedCount,
        finalStatus,
        targetGuildName,
        tokenManager
    }) {
        try {
            let statusPrefix = "ดึงสมาชิกเข้าสำเร็จ";
            if (finalStatus === "SERVER_FULL") {
                statusPrefix = "หยุดทำงาน (เซิร์ฟเวอร์เต็ม)";
            } else if (finalStatus === "FAILED") {
                statusPrefix = "เกิดข้อผิดพลาด";
            } else if (finalStatus === "PARTIAL") {
                statusPrefix = "ดึงเข้าสำเร็จบางส่วน";
            } else if (finalStatus === "INTERRUPTED") {
                statusPrefix = "หยุดชั่วคราวเพื่อรีสตาร์ต (พร้อมทำต่ออัตโนมัติ)";
            }

            const summaryText = `${statusPrefix} **${Number(joinedCount).toLocaleString("th-TH")}** คน` +
                (alreadyCount > 0 ? ` | อยู่ในเซิร์ฟแล้ว **${Number(alreadyCount).toLocaleString("th-TH")}** คน` : "") +
                (failedCount > 0 ? ` | ไม่สำเร็จ **${Number(failedCount).toLocaleString("th-TH")}** คน` : "");

            // Recalculate remaining ready count for target guild (Fail-closed)
            const panel = repository.findPanelByChannelId(job.startedByChannelId || "");
            let freshReadyCount = null;
            try {
                let targetGuild = client.guilds.cache.get(String(job.targetGuildId));
                if (!targetGuild && client.guilds?.fetch) {
                    targetGuild = await client.guilds.fetch(String(job.targetGuildId)).catch(() => null);
                }
                if (targetGuild) {
                    const liveMemberIds = await getLiveTargetMemberIds(targetGuild);
                    freshReadyCount = await countEligibleCandidates({
                        mode,
                        baseConfig: {
                            sourceGuildId: job.sourceGuildId,
                            targetGuildId: job.targetGuildId
                        },
                        tokenManager,
                        targetMemberIds: liveMemberIds
                    });
                } else {
                    freshReadyCount = panel?.lastReadyCount ?? null;
                }
            } catch (_) {
                // If member check failed, retain previous count to avoid presenting inflated numbers
                freshReadyCount = panel?.lastReadyCount ?? null;
            }
            if (panel) {
                repository.savePanel({
                    ...panel,
                    activeJobId: null, // Clear active job association
                    lastReadyCount: freshReadyCount,
                    lastStatusSummary: summaryText
                });

                const channel = await client.channels.fetch(panel.channelId).catch(() => null);
                if (channel) {
                    const message = await channel.messages.fetch(panel.messageId).catch(() => null);
                    if (message) {
                        const payload = buildPanelPayload({
                            mode,
                            panelState: {
                                ...panel,
                                activeJobId: null,
                                lastReadyCount: freshReadyCount,
                                lastStatusSummary: summaryText
                            },
                            readyCount: freshReadyCount,
                            liveJob: null, // Idle
                            targetGuildName
                        });
                        await message.edit(payload).catch(() => {});
                    }
                }
            }
        } catch (_) {}
    }
}

module.exports = new CampaignWorker();
