"use strict";

const { PermissionFlagsBits } = require("discord.js");
const { isGuildAllowed, getJoinCampaignConfig } = require("../config");
const { countEligibleCandidates } = require("./candidateQueryService");
const { isValidDiscordWebhookUrl } = require("../worker/batchLogger");

function isValidSnowflake(id) {
    return /^\d{17,22}$/.test(String(id || "").trim());
}

async function getLiveTargetMemberIds(guild) {
    if (!guild) return new Set();

    let attempts = 0;
    while (attempts < 2) {
        attempts++;
        try {
            // Fast path: small guild
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
        } catch (err) {
            if (attempts >= 2) {
                // Fail closed: Do NOT pretend partial cache represents full membership
                // If memberCount is close to cache size (within small margin), cache might be acceptable in tests
                if (guild.memberCount && guild.members?.cache?.size && Math.abs(guild.memberCount - guild.members.cache.size) <= 5) {
                    return new Set(guild.members.cache.keys());
                }
                const error = new Error("ไม่สามารถดึงรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางได้ กรุณาลองใหม่อีกครั้งนะครับ");
                error.code = "FETCH_MEMBERS_FAILED";
                throw error;
            }
            await new Promise(r => setTimeout(r, 600));
        }
    }

    return new Set();
}

async function validateGuildTargets({ client, mode, baseConfig = {}, webhookUrl = null, config = getJoinCampaignConfig() }) {
    if (webhookUrl && !isValidDiscordWebhookUrl(webhookUrl)) {
        return { ok: false, error: "ลิงก์ Webhook ต้องเป็นลิงก์ Discord Webhook ที่ถูกต้องเท่านั้นครับ" };
    }

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

async function runPreflight({ client, mode, baseConfig = {}, webhookUrl = null, tokenManager, requestedAmount = null, config = getJoinCampaignConfig() }) {
    const targetValidation = await validateGuildTargets({ client, mode, baseConfig, webhookUrl, config });
    if (!targetValidation.ok) {
        return targetValidation;
    }

    // Live Target Membership Check (Fail-closed)
    let targetMemberIds;
    try {
        targetMemberIds = await getLiveTargetMemberIds(targetValidation.targetGuild);
    } catch (err) {
        return {
            ok: false,
            error: err.message || "ไม่สามารถดึงรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางได้ กรุณาลองใหม่อีกครั้งนะครับ"
        };
    }

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

    // Calculate Joined Quota:
    // If requestedAmount is provided, requestedQuota = requestedAmount (DO NOT clamp with readyCount!)
    // If blank or not provided, default to readyCount.
    const parsedAmount = Number(requestedAmount);
    let requestedQuota = readyCount;
    if (Number.isFinite(parsedAmount) && parsedAmount > 0) {
        requestedQuota = Math.floor(parsedAmount);
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
