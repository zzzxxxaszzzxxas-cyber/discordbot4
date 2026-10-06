"use strict";

const oauthTokenManager = require("../../../core/oauthTokenManager");

async function* streamCandidates({
    mode,
    baseConfig = {},
    tokenManager = oauthTokenManager,
    batchSize = 500,
    startCursor = null,
    seenUsers = null,
    onPage = null
}) {
    let afterId = startCursor || null;
    let hasMore = true;
    const tracker = seenUsers instanceof Set ? seenUsers : new Set();
    const sourceGuildId = mode?.requiresSource ? baseConfig.sourceGuildId : null;
    const allowAllGuilds = !mode?.requiresSource;
    const additionalMongoFilter = typeof mode?.buildMongoFilter === "function" ? mode.buildMongoFilter(baseConfig) : null;

    while (hasMore) {
        const page = await tokenManager.listAccessTokenCandidates({
            requiredScopes: ["guilds.join"],
            sourceGuildId,
            targetGuildId: baseConfig.targetGuildId,
            allowAllGuilds,
            additionalFilter: additionalMongoFilter,
            limit: batchSize,
            afterId,
            seenUsers: tracker
        });

        if (typeof onPage === "function") {
            try { onPage(page); } catch (_) {}
        }

        const candidates = page?.candidates !== undefined ? page.candidates : (Array.isArray(page) ? page : []);

        for (const candidate of candidates) {
            const cursor = candidate._id || candidate.recordId ? String(candidate._id || candidate.recordId) : null;
            yield { candidate, cursor };
        }

        const nextCursor = page?.nextCursor ?? (candidates.length > 0 && (candidates[candidates.length - 1]?._id || candidates[candidates.length - 1]?.recordId) ? String(candidates[candidates.length - 1]._id || candidates[candidates.length - 1].recordId) : null);

        // Break if cursor did not advance or no next cursor
        if (!nextCursor || nextCursor === afterId) {
            break;
        }

        afterId = nextCursor;
        hasMore = Boolean(page.hasMore);
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
