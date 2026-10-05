"use strict";

function readBooleanDefaultFalse(value) {
    if (value === undefined || value === null || value === "") return false;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseIdSet(value) {
    return new Set(String(value || "")
        .split(/[,\s]+/)
        .map(item => item.trim())
        .filter(Boolean));
}

function getJoinCampaignConfig(env = process.env) {
    const batchSize = readPositiveInt(env.JOIN_CAMPAIGN_BATCH_SIZE, 500, 1, 1000);
    const allowedGuilds = parseIdSet(env.JOIN_CAMPAIGN_ALLOWED_GUILDS);

    return {
        enabled: readBooleanDefaultFalse(env.JOIN_CAMPAIGN_ENABLED),
        allowedGuilds,
        batchSize,
        maxUsers: batchSize,
        delayMs: readPositiveInt(env.JOIN_CAMPAIGN_DELAY_MS, 1500, 100, 60000),
        progressEvery: readPositiveInt(env.JOIN_CAMPAIGN_PROGRESS_EVERY, 50, 1, 1000),
        refreshMarginMs: readPositiveInt(env.JOIN_CAMPAIGN_REFRESH_MARGIN_MS, 60 * 60 * 1000, 60 * 1000, 7 * 24 * 60 * 60 * 1000),
        failMax: readPositiveInt(env.OAUTH_TOKEN_REFRESH_FAIL_MAX, 3, 1, 20)
    };
}

function isSnowflake(value) {
    return /^\d{17,22}$/.test(String(value || ""));
}

function isGuildAllowed(guildId, config = getJoinCampaignConfig()) {
    if (!isSnowflake(guildId)) return false;
    // Per owner decision: If allowedGuilds is not configured in .env, any guild bot belongs to is allowed
    if (!(config.allowedGuilds instanceof Set) || config.allowedGuilds.size === 0) {
        return true;
    }
    return config.allowedGuilds.has(String(guildId));
}

module.exports = {
    getJoinCampaignConfig,
    isGuildAllowed,
    isSnowflake,
    readBooleanDefaultFalse,
    readPositiveInt,
    parseIdSet
};
