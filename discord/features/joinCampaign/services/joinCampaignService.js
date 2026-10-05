"use strict";

const crypto = require("node:crypto");
const { runPreflight } = require("./preflightService");
const { buildPreflightConfirmationPayload } = require("../ui/confirmationBuilder");
const campaignWorker = require("../worker/campaignWorker");
const { getMode } = require("../modes/modeRegistry");

const stagedSessions = new Map();

class JoinCampaignService {
    constructor() {
        this._activeLock = false;
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

        // Persist initial job in SQLite
        const job = repository.createJob({
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
            webhookUrl: session.webhookUrl,
            startedByUserId: session.startedByUserId,
            startedByChannelId: session.channelId,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });

        // Start worker asynchronously in background
        campaignWorker.startWorker({
            job: {
                ...job,
                startedByChannelId: session.channelId
            },
            client,
            repository
        }).catch(() => {});

        return {
            ok: true,
            jobId,
            message: `เริ่มดึงสมาชิกเข้าสู่ **${preflight.targetGuildName}** เรียบร้อยแล้ว ระบบจะอัปเดตความคืบหน้าให้ทราบอย่างต่อเนื่องครับ`
        };
    }

    getStatus(repository) {
        if (!repository) {
            return { isRunning: false, activeJob: null, lastCompletedJob: null };
        }

        const activeJob = repository.findActiveRunningJob();
        const recentJobs = repository.listRecentJobs({ limit: 1 });
        const lastJob = recentJobs.length > 0 ? recentJobs[0] : null;

        return {
            isRunning: this.isRunning || Boolean(activeJob),
            activeJob: activeJob || null,
            lastCompletedJob: lastJob && lastJob.status !== "RUNNING" ? lastJob : null
        };
    }

    getHistory(repository, { limit = 20, offset = 0 } = {}) {
        if (!repository) return [];
        return repository.listRecentJobs({ limit, offset });
    }

    getMetrics(repository) {
        if (!repository) return { totalCampaigns: 0, totalJoined: 0, totalProcessed: 0, totalFailed: 0 };
        return repository.getMetrics();
    }
}

module.exports = new JoinCampaignService();
