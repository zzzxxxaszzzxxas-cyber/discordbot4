"use strict";

const campaignWorker = require("../worker/campaignWorker");
const { getLiveTargetMemberIds } = require("../services/preflightService");

const MAX_RECOVERY_ATTEMPTS = 5;

async function runStartupRecovery({ client, repository, tokenManager, discord }) {
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
            console.warn(`[JoinCampaign] ⚠️ งาน ${interruptedJob.id} ถูกกู้คืนเกินขีดจำกัด (${MAX_RECOVERY_ATTEMPTS} ครั้ง) ยกเลิกการกู้คืนเพื่อความปลอดภัย`);
            repository.updateJob(interruptedJob.id, {
                status: "FAILED",
                last_error: `กู้คืนเกินขีดจำกัด ${MAX_RECOVERY_ATTEMPTS} ครั้ง`
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

        // 3. Fetch current target guild members to avoid redundant joins
        let targetMemberIds = null;
        if (client && interruptedJob.targetGuildId) {
            try {
                let targetGuild = client.guilds.cache.get(interruptedJob.targetGuildId);
                if (!targetGuild && client.guilds?.fetch) {
                    targetGuild = await client.guilds.fetch(interruptedJob.targetGuildId).catch(() => null);
                }
                if (targetGuild) {
                    targetMemberIds = await getLiveTargetMemberIds(targetGuild);
                }
            } catch (err) {
                console.warn(`[JoinCampaign] ⚠️ ไม่สามารถดึงรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางระหว่างกู้คืนได้:`, err.message);
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
        } catch (err) {
            console.error(`[JoinCampaign] ❌ ไม่สามารถกู้คืนงานเดิมได้:`, err.message);
        }

        return { recovered: true, jobId: interruptedJob.id, workerPromise };
    } catch (err) {
        console.error(`[JoinCampaign] ❌ เกิดข้อผิดพลาดในการตรวจสอบงานค้าง:`, err.message);
        return { recovered: false, error: err.message };
    }
}

module.exports = {
    runStartupRecovery
};
