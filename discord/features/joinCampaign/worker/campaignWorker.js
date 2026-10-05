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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

class CampaignWorker {
    constructor() {
        this._activeWorkerPromise = null;
        this._currentJobId = null;
        this._isStopping = false;
    }

    get isRunning() {
        return Boolean(this._activeWorkerPromise);
    }

    get currentJobId() {
        return this._currentJobId;
    }

    async startWorker({
        job,
        client,
        repository,
        tokenManager = oauthTokenManager,
        discord = discordApi,
        config = getJoinCampaignConfig()
    }) {
        if (this.isRunning) {
            throw new Error("ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ");
        }

        this._currentJobId = job.id;
        this._isStopping = false;

        this._activeWorkerPromise = this._executeLoop({
            job,
            client,
            repository,
            tokenManager,
            discord,
            config
        }).finally(() => {
            this._activeWorkerPromise = null;
            this._currentJobId = null;
        });

        return { ok: true, jobId: job.id };
    }

    async _executeLoop({
        job,
        client,
        repository,
        tokenManager,
        discord,
        config
    }) {
        const startTime = job.createdAt || Date.now();
        const mode = getMode(job.mode);
        const targetGuildId = String(job.targetGuildId);
        const targetGuild = client.guilds.cache.get(targetGuildId);
        const targetGuildName = targetGuild?.name || job.targetGuildName || targetGuildId;
        const requestedQuota = Number(job.requestedAmount) || 0;

        let joinedCount = Number(job.joinedCount) || 0;
        let alreadyCount = Number(job.alreadyCount) || 0;
        let failedCount = Number(job.failedCount) || 0;
        let processedCount = Number(job.processedCount) || 0;
        let retryCount = Number(job.retryCount) || 0;

        const batchBuffer = [];
        let batchIndex = 1;
        let lastPanelUpdateAt = Date.now();

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
                    requestedAmount: requestedQuota
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

        try {
            // Stream candidates from MongoDB via central token manager
            const candidateStream = streamCandidates({
                mode,
                baseConfig: {
                    sourceGuildId: job.sourceGuildId,
                    targetGuildId: job.targetGuildId
                },
                tokenManager,
                batchSize: config.batchSize
            });

            // Stream candidate users one by one until Joined Quota is met
            for await (const candidate of candidateStream) {
                if (this._isStopping) break;
                if (requestedQuota > 0 && joinedCount >= requestedQuota) {
                    break; // Reached target Joined Quota!
                }

                const userId = String(candidate.userId || candidate.discord?.userId || "").trim();
                if (!userId) continue;

                processedCount++;

                // JIT Token Retrieval & Refresh via central oauthTokenManager
                const tokenResult = await tokenManager.getAccessToken({
                    userId,
                    tokenField: candidate.tokenField || "oauth",
                    env: process.env
                });

                const accessToken = tokenResult?.accessToken;
                if (!accessToken) {
                    failedCount++;
                    batchBuffer.push({ userId, status: "failed" });
                    repository.updateJob(job.id, {
                        joinedCount,
                        alreadyCount,
                        failedCount,
                        processedCount,
                        retryCount
                    });
                    continue;
                }

                // Call Discord API to add member to target guild
                let res = await discord.addMemberToGuild(targetGuildId, userId, accessToken);

                // Handle rate limits with backoff
                if (res?.status === 429) {
                    retryCount++;
                    const retryAfter = Number(res.retryAfter) || 2000;
                    await sleep(retryAfter);
                    res = await discord.addMemberToGuild(targetGuildId, userId, accessToken);
                }

                if (res?.ok || res?.status === 201) {
                    joinedCount++;
                    batchBuffer.push({ userId, status: "joined" });
                } else if (res?.status === 204) {
                    alreadyCount++;
                    batchBuffer.push({ userId, status: "already_member" });
                } else {
                    // Check if guild is at capacity (code 30005) or bot lacks permissions
                    if (res?.code === 30005) {
                        failedCount++;
                        batchBuffer.push({ userId, status: "guild_full" });
                        break; // Server full, stop trying
                    }
                    failedCount++;
                    batchBuffer.push({ userId, status: "failed" });
                }

                // Checkpoint to SQLite
                repository.updateJob(job.id, {
                    joinedCount,
                    alreadyCount,
                    failedCount,
                    processedCount,
                    retryCount
                });

                // Batch logging every 50 users
                if (batchBuffer.length >= config.progressEvery) {
                    const batchItems = batchBuffer.splice(0, config.progressEvery);
                    const batchJoined = batchItems.filter(i => i.status === "joined").length;
                    const batchAlready = batchItems.filter(i => i.status === "already_member").length;
                    const batchFailed = batchItems.filter(i => i.status === "failed" || i.status === "guild_full").length;

                    await sendBatchLog({
                        webhookUrl: job.webhookUrl,
                        mode,
                        batchNumber: batchIndex++,
                        items: batchItems,
                        joinedCount: batchJoined,
                        alreadyCount: batchAlready,
                        failedCount: batchFailed,
                        targetGuildName
                    });
                }

                // Update panel progress
                await updatePanelDebounced(false);

                // Safe inter-request delay
                await sleep(config.delayMs);
            }

            // Flush remaining batch buffer if any
            if (batchBuffer.length > 0) {
                const batchJoined = batchBuffer.filter(i => i.status === "joined").length;
                const batchAlready = batchBuffer.filter(i => i.status === "already_member").length;
                const batchFailed = batchBuffer.filter(i => i.status === "failed" || i.status === "guild_full").length;

                await sendBatchLog({
                    webhookUrl: job.webhookUrl,
                    mode,
                    batchNumber: batchIndex++,
                    items: batchBuffer,
                    joinedCount: batchJoined,
                    alreadyCount: batchAlready,
                    failedCount: batchFailed,
                    targetGuildName
                });
            }

            // Mark job completed in SQLite
            const completedAt = Date.now();
            repository.updateJob(job.id, {
                status: "COMPLETED",
                joinedCount,
                alreadyCount,
                failedCount,
                processedCount,
                retryCount,
                completedAt
            });

            // Send Final Summary Embed to Webhook
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
                durationMs: completedAt - startTime
            });

            // Final Panel Update: unlock button and show completed summary
            await this._finishPanelUpdate({
                job,
                client,
                repository,
                mode,
                joinedCount,
                alreadyCount,
                failedCount,
                targetGuildName,
                tokenManager
            });

        } catch (err) {
            repository.updateJob(job.id, {
                status: "FAILED",
                joinedCount,
                alreadyCount,
                failedCount,
                processedCount,
                retryCount,
                completedAt: Date.now()
            });
            throw err;
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
        targetGuildName,
        tokenManager
    }) {
        try {
            const panels = client.guilds.cache.map(g => repository.findPanelByChannelId(g.id)).filter(Boolean);
            // Also check all panels in repository
            const recentJobs = repository.listRecentJobs ? repository.listRecentJobs({ limit: 1 }) : [];
            const summaryText = `ดึงสมาชิกเข้าสำเร็จ **${Number(joinedCount).toLocaleString("th-TH")}** คน` +
                (alreadyCount > 0 ? ` | อยู่ในเซิร์ฟแล้ว **${Number(alreadyCount).toLocaleString("th-TH")}** คน` : "") +
                (failedCount > 0 ? ` | ไม่สำเร็จ **${Number(failedCount).toLocaleString("th-TH")}** คน` : "");

            // Recalculate remaining ready count for target guild
            const targetGuild = client.guilds.cache.get(String(job.targetGuildId));
            const liveMemberIds = targetGuild ? await getLiveTargetMemberIds(targetGuild) : new Set();
            const freshReadyCount = await countEligibleCandidates({
                mode,
                baseConfig: {
                    sourceGuildId: job.sourceGuildId,
                    targetGuildId: job.targetGuildId
                },
                tokenManager,
                targetMemberIds: liveMemberIds
            }).catch(() => null);

            // Update all known panels in SQLite that match this target or channel
            const panel = repository.findPanelByChannelId(job.startedByChannelId || "");
            if (panel) {
                repository.savePanel({
                    ...panel,
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
                                lastReadyCount: freshReadyCount,
                                lastStatusSummary: summaryText
                            },
                            readyCount: freshReadyCount,
                            liveJob: null, // Idle!
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
