"use strict";

const { PermissionFlagsBits } = require("discord.js");
const { isGuildAllowed, getJoinCampaignConfig } = require("../config");
const { countEligibleCandidates } = require("./candidateQueryService");

function isValidSnowflake(id) {
    return /^\d{17,22}$/.test(String(id || "").trim());
}

async function getLiveTargetMemberIds(guild) {
    if (!guild) return new Set();

    try {
        // Fast path: if small guild, fetch full member cache
        if (guild.memberCount && guild.memberCount <= 1000) {
            const members = await guild.members.fetch();
            return new Set(members.keys());
        }

        // Chunked fetch for larger guilds
        const memberIds = new Set();
        let after = "0";
        while (true) {
            const batch = await guild.members.list({ limit: 1000, after });
            if (!batch || batch.size === 0) break;
            for (const [id] of batch) {
                memberIds.add(id);
            }
            if (batch.size < 1000) break;
            after = Array.from(batch.keys())[batch.size - 1];
        }
        return memberIds;
    } catch (_) {
        // Fallback to whatever members are in cache if list/fetch hits rate limit or error
        return new Set(guild.members?.cache?.keys() || []);
    }
}

async function validateGuildTargets({ client, mode, baseConfig = {}, config = getJoinCampaignConfig() }) {
    const targetGuildId = String(baseConfig.targetGuildId || "").trim();
    if (!targetGuildId) {
        return { ok: false, error: "กรุณาระบุไอดีเซิร์ฟเวอร์ปลายทาง" };
    }

    if (!isValidSnowflake(targetGuildId)) {
        return { ok: false, error: "ไอดีเซิร์ฟเวอร์ปลายทางต้องเป็นตัวเลข 17–20 หลัก" };
    }

    if (!isGuildAllowed(targetGuildId, config)) {
        return { ok: false, error: "เซิร์ฟเวอร์ปลายทางนี้ไม่อยู่ในรายการที่อนุญาตให้เริ่มงาน" };
    }

    let targetGuild = client.guilds.cache.get(targetGuildId);
    if (!targetGuild) {
        try {
            targetGuild = await client.guilds.fetch(targetGuildId);
        } catch (_) {
            return { ok: false, error: "บอทไม่ได้อยู่ในเซิร์ฟเวอร์ปลายทาง กรุณาเชิญบอทเข้าเซิร์ฟเวอร์ก่อนนะครับ" };
        }
    }

    if (!targetGuild) {
        return { ok: false, error: "บอทไม่ได้อยู่ในเซิร์ฟเวอร์ปลายทาง กรุณาเชิญบอทเข้าเซิร์ฟเวอร์ก่อนนะครับ" };
    }

    // Check bot permission in target guild
    const botMember = targetGuild.members?.me || await targetGuild.members.fetchMe().catch(() => null);
    if (botMember && !botMember.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
        return { ok: false, error: "บอทขาดสิทธิ์ 'สร้างคำเชิญ' (Create Instant Invite) ในเซิร์ฟเวอร์ปลายทาง" };
    }

    let sourceGuild = null;
    let sourceGuildId = null;

    if (mode.requiresSource) {
        sourceGuildId = String(baseConfig.sourceGuildId || "").trim();
        if (!sourceGuildId) {
            return { ok: false, error: "กรุณาระบุไอดีเซิร์ฟเวอร์ต้นทาง" };
        }
        if (!isValidSnowflake(sourceGuildId)) {
            return { ok: false, error: "ไอดีเซิร์ฟเวอร์ต้นทางต้องเป็นตัวเลข 17–20 หลัก" };
        }
        if (sourceGuildId === targetGuildId) {
            return { ok: false, error: "เซิร์ฟเวอร์ต้นทางและปลายทางต้องไม่เป็นเซิร์ฟเวอร์เดียวกัน" };
        }

        sourceGuild = client.guilds.cache.get(sourceGuildId);
        if (!sourceGuild) {
            try {
                sourceGuild = await client.guilds.fetch(sourceGuildId);
            } catch (_) {}
        }
    }

    return {
        ok: true,
        targetGuild,
        targetGuildId,
        targetGuildName: targetGuild.name,
        sourceGuild,
        sourceGuildId,
        sourceGuildName: sourceGuild?.name || null
    };
}

async function runPreflight({ client, mode, baseConfig = {}, tokenManager, requestedAmount = null }) {
    const targetValidation = await validateGuildTargets({ client, mode, baseConfig });
    if (!targetValidation.ok) {
        return targetValidation;
    }

    // Live Target Membership Check
    const targetMemberIds = await getLiveTargetMemberIds(targetValidation.targetGuild);

    // Calculate live ready count subtracting members already in Target Guild
    const readyCount = await countEligibleCandidates({
        mode,
        baseConfig,
        tokenManager,
        targetMemberIds
    });

    if (readyCount === 0) {
        return {
            ok: false,
            error: "ไม่พบสมาชิกที่พร้อมดึงเข้าเซิร์ฟเวอร์ในขณะนี้ (หรือทุกคนอยู่ในเซิร์ฟเวอร์เรียบร้อยแล้ว)"
        };
    }

    // Calculate Joined Quota
    const parsedAmount = Number(requestedAmount);
    let requestedQuota = readyCount;
    if (Number.isFinite(parsedAmount) && parsedAmount > 0) {
        requestedQuota = Math.min(Math.floor(parsedAmount), readyCount);
    }

    return {
        ok: true,
        targetGuild: targetValidation.targetGuild,
        targetGuildId: targetValidation.targetGuildId,
        targetGuildName: targetValidation.targetGuildName,
        sourceGuild: targetValidation.sourceGuild,
        sourceGuildId: targetValidation.sourceGuildId,
        sourceGuildName: targetValidation.sourceGuildName,
        targetMemberIds,
        readyCount,
        requestedQuota
    };
}

module.exports = {
    isValidSnowflake,
    getLiveTargetMemberIds,
    validateGuildTargets,
    runPreflight
};
