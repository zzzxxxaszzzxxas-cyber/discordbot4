"use strict";

const oauthTokenManager = require("../../../core/oauthTokenManager");

async function* streamCandidates({
    mode,
    baseConfig = {},
    tokenManager = oauthTokenManager,
    batchSize = 500,
    startCursor = null,
    seenUsers = null
}) {
    let afterId = startCursor || null;
    let hasMore = true;
    const tracker = seenUsers instanceof Set ? seenUsers : new Set();
    const sourceGuildId = mode.requiresSource ? baseConfig.sourceGuildId : null;

    while (hasMore) {
        const page = await tokenManager.listAccessTokenCandidates({
            requiredScopes: ["guilds.join"],
            sourceGuildId,
            targetGuildId: baseConfig.targetGuildId,
            allowAllGuilds: !mode.requiresSource,
            limit: batchSize,
            afterId,
            seenUsers: tracker
        });

        const candidates = Array.isArray(page) ? page : (page?.candidates || []);
        if (candidates.length === 0) {
            break;
        }

        for (const candidate of candidates) {
            const cursor = candidate._id || candidate.recordId ? String(candidate._id || candidate.recordId) : null;
            yield { candidate, cursor };
        }

        afterId = page.nextCursor || (candidates[candidates.length - 1]?._id ? String(candidates[candidates.length - 1]._id) : null);
        hasMore = Boolean(page.hasMore && afterId);
    }
}

async function countEligibleCandidates({
    mode,
    baseConfig = {},
    tokenManager = oauthTokenManager,
    targetMemberIds = new Set()
}) {
    let readyCount = 0;
    const candidatesStream = streamCandidates({ mode, baseConfig, tokenManager });

    for await (const item of candidatesStream) {
        const candidate = item.candidate || item;
        const userId = String(candidate.userId || candidate.discord?.userId || "").trim();
        if (userId && !targetMemberIds.has(userId)) {
            readyCount++;
        }
    }

    return readyCount;
}

module.exports = {
    streamCandidates,
    countEligibleCandidates
};
