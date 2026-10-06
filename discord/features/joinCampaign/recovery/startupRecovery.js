"use strict";

const campaignWorker = require("../worker/campaignWorker");
const { getLiveTargetMemberIds } = require("../services/preflightService");
const { getJoinCampaignConfig } = require("../config");

const MAX_RECOVERY_ATTEMPTS = 5;

function dispatchRecoveryAlert({ code, title, description, details = {} }) {
    try {
        const { sendWebhookEvent } = require("../../../core/webhooks");
        if (typeof sendWebhookEvent === "function") {
            sendWebhookEvent({
                category: "SYSTEM",
                severity: "CRITICAL",
                actionRequired: true,
                code: code || "join_campaign.recovery_failed",
                title: title || "Join Campaign: การกู้คืนล้มเหลว",
                description: description || "เกิดข้อผิดพลาดในการกู้คืนงานเดิม",
                fields: Object.entries(details).map(([name, value]) => ({
                    name,
                    value: String(value),
                    inline: true
                }))
            });
        }
    } catch (_) {}
}

async function runStartupRecovery({ client, repository, tokenManager, discord }) {
    const config = getJoinCampaignConfig();
    if (!config.enabled) {
        return { recovered: false, reason: "disabled_by_master_switch" };
    }

    if (!repository || typeof repository.findActiveRunningJob !== "function") {
        return { recovered: false, reason: "no_repository" };
    }

    try {
        const interruptedJob = repository.findActiveRunningJob();
        if (!interruptedJob) {
            return { recovered: false, reason: "no_interrupted_jobs" };
        }

        const currentRecoveryCount = interruptedJob.recoveryCount || interruptedJob.recovery_count || 0;
        if (currentRecoveryCount >= MAX_RECOVERY_ATTEMPTS) {
            const failReason = `กู้คืนเกินขีดจำกัด ${MAX_RECOVERY_ATTEMPTS} ครั้ง`;
            console.warn(`[JoinCampaign] ⚠️ งาน ${interruptedJob.id} ถูกกู้คืนเกินขีดจำกัด (${MAX_RECOVERY_ATTEMPTS} ครั้ง) ยกเลิกการกู้คืนเพื่อความปลอดภัย`);
            repository.updateJob(interruptedJob.id, {
                status: "FAILED",
                lastError: failReason,
                completedAt: Date.now()
            });
            dispatchRecoveryAlert({
                code: "join_campaign.max_recovery_exceeded",
                title: "Join Campaign: การกู้คืนล้มเหลวเกินกำหนด",
                description: `งาน ${interruptedJob.id} ถูกกู้คืนเกินขีดจำกัด ${MAX_RECOVERY_ATTEMPTS} ครั้งและถูกยกเลิก`,
                details: {
                    campaignId: interruptedJob.id,
                    targetGuildId: interruptedJob.targetGuildId,
                    recoveryAttempts: currentRecoveryCount
                }
            });
            return { recovered: false, reason: "max_recovery_exceeded" };
        }

        console.log(`[JoinCampaign] 🔄 ตรวจพบงานที่ค้างอยู่จากการรีสตาร์ต: ${interruptedJob.id} (สำเร็จแล้ว ${interruptedJob.joinedCount}/${interruptedJob.requestedAmount})`);

        // 1. Release all leased items back to PENDING
        if (typeof repository.releaseExpiredLeases === "function") {
            repository.releaseExpiredLeases(interruptedJob.id, true);
        }

        // 2. Increment recovery count
        const nextRecoveryCount = currentRecoveryCount + 1;
        repository.updateJob(interruptedJob.id, {
            recovery_count: nextRecoveryCount,
            status: "RUNNING"
        });
        interruptedJob.recoveryCount = nextRecoveryCount;
        interruptedJob.recovery_count = nextRecoveryCount;

        // 3. Fetch current target guild members to avoid redundant joins (Fail-closed)
        let targetMemberIds = null;
        if (client && interruptedJob.targetGuildId) {
            let targetGuild = client.guilds.cache.get(interruptedJob.targetGuildId);
            if (!targetGuild && client.guilds?.fetch) {
                targetGuild = await client.guilds.fetch(interruptedJob.targetGuildId).catch(() => null);
            }
            if (!targetGuild) {
                const failMsg = "ไม่พบเซิร์ฟเวอร์ปลายทาง หรือบอทไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมายแล้ว (Fail-Closed)";
                console.error(`[JoinCampaign] ❌ ${failMsg}`);
                repository.updateJob(interruptedJob.id, {
                    status: "FAILED",
                    lastError: failMsg,
                    completedAt: Date.now()
                });
                dispatchRecoveryAlert({
                    code: "join_campaign.recovery_target_missing",
                    title: "Join Campaign: เซิร์ฟเวอร์เป้าหมายไม่พร้อมใช้งานขณะกู้คืน",
                    description: failMsg,
                    details: {
                        campaignId: interruptedJob.id,
                        targetGuildId: interruptedJob.targetGuildId
                    }
                });
                return { recovered: false, error: failMsg, jobId: interruptedJob.id };
            }
            try {
                targetMemberIds = await getLiveTargetMemberIds(targetGuild);
            } catch (err) {
                const failMsg = `ไม่สามารถดึงรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางได้: ${err.message}`;
                console.error(`[JoinCampaign] ❌ ${failMsg}`);
                repository.updateJob(interruptedJob.id, {
                    status: "FAILED",
                    lastError: failMsg,
                    completedAt: Date.now()
                });
                dispatchRecoveryAlert({
                    code: "join_campaign.recovery_member_fetch_failed",
                    title: "Join Campaign: ตรวจสอบรายชื่อสมาชิกล้มเหลวขณะกู้คืน",
                    description: failMsg,
                    details: {
                        campaignId: interruptedJob.id,
                        targetGuildId: interruptedJob.targetGuildId
                    }
                });
                return { recovered: false, error: failMsg, jobId: interruptedJob.id };
            }
        }

        // 4. Auto-resume campaign worker asynchronously
        let workerPromise = null;
        try {
            const startResult = await campaignWorker.startWorker({
                job: interruptedJob,
                client,
                repository,
                targetMemberIds,
                ...(tokenManager ? { tokenManager } : {}),
                ...(discord ? { discord } : {})
            });
            workerPromise = startResult?.workerPromise || null;
            if (!workerPromise) {
                throw new Error("Worker promise was null or undefined");
            }
        } catch (err) {
            console.error(`[JoinCampaign] ❌ ไม่สามารถกู้คืนงานเดิมได้:`, err.message);
            repository.updateJob(interruptedJob.id, {
                status: "FAILED",
                lastError: `กู้คืนงานเดิมไม่สำเร็จ: ${err.message}`,
                completedAt: Date.now()
            });
            dispatchRecoveryAlert({
                code: "join_campaign.recovery_worker_start_failed",
                title: "Join Campaign: ไม่สามารถเริ่ม Worker กู้คืนได้",
                description: err.message,
                details: {
                    campaignId: interruptedJob.id,
                    targetGuildId: interruptedJob.targetGuildId
                }
            });
            return { recovered: false, error: err.message, jobId: interruptedJob.id };
        }

        return { recovered: true, jobId: interruptedJob.id, workerPromise };
    } catch (err) {
        console.error(`[JoinCampaign] ❌ เกิดข้อผิดพลาดในการตรวจสอบงานค้าง:`, err.message);
        dispatchRecoveryAlert({
            code: "join_campaign.recovery_error",
            title: "Join Campaign: เกิดข้อผิดพลาดร้ายแรงขณะกู้คืน",
            description: err.message
        });
        return { recovered: false, error: err.message };
    }
}

module.exports = {
    runStartupRecovery
};
