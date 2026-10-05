"use strict";

const crypto = require("node:crypto");
const { runPreflight } = require("./preflightService");
const { buildPreflightConfirmationPayload } = require("../ui/confirmationBuilder");
const campaignWorker = require("../worker/campaignWorker");
const { getMode } = require("../modes/modeRegistry");

const stagedSessions = new Map();

class JoinCampaignService {
    constructor() {
        this._activeWebhooks = new Map();
        this._activeTargetMemberSets = new Map();
    }

    get isRunning() {
        return campaignWorker.isRunning;
    }

    async stageCampaign({
        client,
        repository,
        mode,
        baseConfig,
        requestedAmount = null,
        webhookUrl = null,
        startedByUserId = null,
        channelId = null
    }) {
        if (this.isRunning) {
            return {
                ok: false,
                error: "ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ"
            };
        }

        const preflight = await runPreflight({
            client,
            mode,
            baseConfig,
            webhookUrl,
            requestedAmount
        });

        if (!preflight.ok) {
            return preflight;
        }

        const stageId = `stage_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const session = {
            stageId,
            modeId: mode.id,
            baseConfig,
            preflight,
            webhookUrl: webhookUrl ? String(webhookUrl).trim() : null,
            startedByUserId,
            channelId,
            createdAt: Date.now()
        };

        stagedSessions.set(stageId, session);

        // Auto-cleanup staged session after 15 minutes
        setTimeout(() => {
            stagedSessions.delete(stageId);
        }, 15 * 60 * 1000).unref();

        const payload = buildPreflightConfirmationPayload({
            stageId,
            mode,
            sourceGuildName: preflight.sourceGuildName,
            sourceGuildId: preflight.sourceGuildId,
            targetGuildName: preflight.targetGuildName,
            targetGuildId: preflight.targetGuildId,
            readyCount: preflight.readyCount,
            requestedQuota: preflight.requestedQuota,
            hasWebhook: Boolean(webhookUrl)
        });

        return {
            ok: true,
            stageId,
            payload
        };
    }

    async confirmAndStartCampaign({ stageId, client, repository }) {
        const session = stagedSessions.get(stageId);
        if (!session) {
            return {
                ok: false,
                error: "ข้อมูลการเตรียมงานหมดอายุแล้ว กรุณากดเริ่มงานใหม่อีกครั้งนะครับ"
            };
        }

        stagedSessions.delete(stageId);

        if (this.isRunning) {
            return {
                ok: false,
                error: "ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ"
            };
        }

        const jobId = `camp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const mode = getMode(session.modeId);
        const { preflight } = session;

        // Persist initial job in SQLite (Notice: webhookUrl is NOT stored in SQLite)
        let job;
        try {
            job = repository.createJob({
                id: jobId,
                mode: mode.id,
                sourceGuildId: preflight.sourceGuildId,
                sourceGuildName: preflight.sourceGuildName,
                targetGuildId: preflight.targetGuildId,
                targetGuildName: preflight.targetGuildName,
                status: "RUNNING",
                requestedAmount: preflight.requestedQuota,
                selectedAmount: preflight.readyCount,
                joinedCount: 0,
                alreadyCount: 0,
                failedCount: 0,
                processedCount: 0,
                retryCount: 0,
                currentConcurrency: 8,
                currentThroughput: 0.0,
                recoveryCount: 0,
                candidateCursor: null,
                lastError: null,
                startedByUserId: session.startedByUserId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        } catch (err) {
            if (err?.code === "ACTIVE_CAMPAIGN_EXISTS" || String(err?.message || "").includes("UNIQUE constraint failed")) {
                return {
                    ok: false,
                    error: "ตอนนี้มีงานดึงสมาชิกกำลังทำงานอยู่ กรุณารอให้งานเดิมเสร็จก่อนนะครับ"
                };
            }
            throw err;
        }

        // Retain webhook in memory for active campaign
        if (session.webhookUrl) {
            this._activeWebhooks.set(jobId, session.webhookUrl);
        }
        if (preflight.targetMemberIds) {
            this._activeTargetMemberSets.set(jobId, preflight.targetMemberIds);
        }

        // Associate panel with active job and requested quota in SQLite
        try {
            const panel = repository.findPanelByChannelId(session.channelId);
            if (panel) {
                repository.savePanel({
                    ...panel,
                    activeJobId: jobId,
                    requestedAmount: preflight.requestedQuota,
                    lastReadyCount: preflight.readyCount
                });
            }
        } catch (_) {}

        // Start bounded adaptive worker pool in background
        campaignWorker.startWorker({
            job: {
                ...job,
                startedByChannelId: session.channelId,
                webhookUrl: session.webhookUrl,
                targetMemberIds: preflight.targetMemberIds
            },
            client,
            repository
        }).finally(() => {
            this._activeWebhooks.delete(jobId);
            this._activeTargetMemberSets.delete(jobId);
        }).catch(() => {});

        return {
            ok: true,
            jobId,
            requestedAmount: preflight.requestedQuota,
            message: `เริ่มดึงสมาชิกเข้าสู่ **${preflight.targetGuildName}** เรียบร้อยแล้ว ระบบจะอัปเดตความคืบหน้าให้ทราบอย่างต่อเนื่องครับ`
        };
    }

    getStatus(repository) {
        if (!repository) {
            return {
                isRunning: false,
                active: null,
                last: null,
                activeJob: null,
                lastCompletedJob: null
            };
        }

        const activeJob = repository.findActiveRunningJob();
        const recentJobs = repository.listRecentJobs({ limit: 1 });
        const lastJob = recentJobs.length > 0 ? recentJobs[0] : null;

        const formatForDashboard = (job) => {
            if (!job) return null;
            return {
                id: job.id,
                mode: job.mode,
                targetGuildId: job.targetGuildId,
                target_guild_id: job.targetGuildId,
                targetGuildName: job.targetGuildName,
                target_guild_name: job.targetGuildName,
                sourceGuildId: job.sourceGuildId,
                source_guild_id: job.sourceGuildId,
                sourceGuildName: job.sourceGuildName,
                source_guild_name: job.sourceGuildName,
                status: (job.status || "").toLowerCase(),
                requestedAmount: job.requestedAmount,
                requested_amount: job.requestedAmount,
                maxUsers: job.requestedAmount,
                joinedCount: job.joinedCount,
                joined_count: job.joinedCount,
                joined: job.joinedCount,
                alreadyCount: job.alreadyCount,
                already_count: job.alreadyCount,
                already_member_count: job.alreadyCount,
                alreadyMember: job.alreadyCount,
                failedCount: job.failedCount,
                failed_count: job.failedCount,
                failed: job.failedCount,
                processedCount: job.processedCount,
                processed_count: job.processedCount,
                retryCount: job.retryCount,
                retry_count: job.retryCount,
                currentConcurrency: job.currentConcurrency,
                current_concurrency: job.currentConcurrency,
                currentThroughput: job.currentThroughput || 0,
                current_throughput: job.currentThroughput || 0,
                createdAt: job.createdAt,
                created_at: job.createdAt,
                started_at: job.createdAt,
                completedAt: job.completedAt,
                completed_at: job.completedAt
            };
        };

        const activeFormatted = formatForDashboard(activeJob);
        const lastFormatted = formatForDashboard(lastJob && lastJob.status !== "RUNNING" ? lastJob : null);

        return {
            isRunning: this.isRunning || Boolean(activeJob),
            active: activeFormatted,
            last: lastFormatted,
            activeJob,
            lastCompletedJob: lastJob && lastJob.status !== "RUNNING" ? lastJob : null
        };
    }

    getHistory(repository, { limit = 20, offset = 0 } = {}) {
        if (!repository) return [];
        const raw = repository.listRecentJobs({ limit, offset });
        return raw.map(job => ({
            id: job.id,
            mode: job.mode,
            targetGuildId: job.targetGuildId,
            target_guild_id: job.targetGuildId,
            targetGuildName: job.targetGuildName,
            target_guild_name: job.targetGuildName,
            sourceGuildId: job.sourceGuildId,
            source_guild_id: job.sourceGuildId,
            sourceGuildName: job.sourceGuildName,
            source_guild_name: job.sourceGuildName,
            status: (job.status || "").toLowerCase(),
            requestedAmount: job.requestedAmount,
            requested_amount: job.requestedAmount,
            joinedCount: job.joinedCount,
            joined_count: job.joinedCount,
            alreadyCount: job.alreadyCount,
            already_count: job.alreadyCount,
            already_member_count: job.alreadyCount,
            failedCount: job.failedCount,
            failed_count: job.failedCount,
            processedCount: job.processedCount,
            processed_count: job.processedCount,
            retryCount: job.retryCount,
            retry_count: job.retryCount,
            currentConcurrency: job.currentConcurrency,
            current_concurrency: job.currentConcurrency,
            currentThroughput: job.currentThroughput || 0,
            current_throughput: job.currentThroughput || 0,
            createdAt: job.createdAt,
            created_at: job.createdAt,
            started_at: job.createdAt,
            completedAt: job.completedAt,
            completed_at: job.completedAt
        }));
    }

    getMetrics(repository) {
        if (!repository) return { totalJobs: 0, totalCampaigns: 0, totalJoined: 0, totalProcessed: 0, totalFailed: 0, successRatePercent: 0 };
        return repository.getMetrics();
    }
}

module.exports = new JoinCampaignService();
