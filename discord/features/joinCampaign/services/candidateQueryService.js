"use strict";

const oauthTokenManager = require("../../../core/oauthTokenManager");

async function* streamCandidates({
    mode,
    baseConfig = {},
    tokenManager = oauthTokenManager,
    batchSize = 500
}) {
    let afterId = null;
    let hasMore = true;
    const seenUsers = new Set();
    const sourceGuildId = mode.requiresSource ? baseConfig.sourceGuildId : null;

    while (hasMore) {
        const page = await tokenManager.listAccessTokenCandidates({
            requiredScopes: ["guilds.join"],
            sourceGuildId,
            targetGuildId: baseConfig.targetGuildId,
            allowAllGuilds: !mode.requiresSource,
            limit: batchSize,
            afterId,
            seenUsers
        });

        if (!page || !page.candidates || page.candidates.length === 0) {
            break;
        }

        for (const candidate of page.candidates) {
            yield candidate;
        }

        afterId = page.nextCursor || page.candidates[page.candidates.length - 1]?._id;
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

    for await (const candidate of candidatesStream) {
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
