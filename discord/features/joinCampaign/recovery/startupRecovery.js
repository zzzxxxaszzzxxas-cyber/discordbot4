"use strict";

const campaignWorker = require("../worker/campaignWorker");

async function runStartupRecovery({ client, repository }) {
    if (!repository || typeof repository.findActiveRunningJob !== "function") {
        return { recovered: false, reason: "no_repository" };
    }

    try {
        const interruptedJob = repository.findActiveRunningJob();
        if (!interruptedJob) {
            return { recovered: false, reason: "no_interrupted_jobs" };
        }

        console.log(`[JoinCampaign] 🔄 ตรวจพบงานที่ค้างอยู่จากการรีสตาร์ต: ${interruptedJob.id} (${interruptedJob.joinedCount}/${interruptedJob.requestedAmount})`);

        // Release expired leases on candidate items
        if (typeof repository.releaseExpiredLeases === "function") {
            repository.releaseExpiredLeases(interruptedJob.id);
        }

        // Auto-resume campaign worker asynchronously
        campaignWorker.startWorker({
            job: interruptedJob,
            client,
            repository
        }).catch((err) => {
            console.error(`[JoinCampaign] ❌ ไม่สามารถกู้คืนงานเดิมได้:`, err.message);
        });

        return { recovered: true, jobId: interruptedJob.id };
    } catch (err) {
        console.error(`[JoinCampaign] ❌ เกิดข้อผิดพลาดในการตรวจสอบงานค้าง:`, err.message);
        return { recovered: false, error: err.message };
    }
}

module.exports = {
    runStartupRecovery
};
