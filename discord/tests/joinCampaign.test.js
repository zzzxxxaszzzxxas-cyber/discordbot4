const fs = require("node:fs");
const test = require("node:test");

const joinCampaign = require("../features/joinCampaign");
const {
    listJoinCampaignTargets,
    resolveJoinCampaignTarget
} = require("../index/joinCampaignRoutes");

test("join campaign candidate summary uses only tokens with guilds.join", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const docs = [
        {
            userId: "100",
            tokenField: "oauth",
            scope: "identify guilds.join"
        },
        {
            userId: "200",
            tokenField: "adminOAuth",
            scope: "identify guilds guilds.join"
        },
        {
            userId: "300",
            tokenField: "oauth",
            scope: "identify email"
        },
        {
            userId: "200",
            tokenField: "oauth",
            scope: "identify guilds.join"
        }
    ];

    const summary = joinCampaign.summarizeJoinCandidates(docs);

    t.assert.equal(summary.scannedRecords, 4);
    t.assert.equal(summary.uniqueUsers, 3);
    t.assert.equal(summary.usableUsers, 2);
    t.assert.equal(summary.missingScope, 1);
    t.assert.equal(summary.byTokenField.oauth, 1);
    t.assert.equal(summary.byTokenField.adminOAuth, 1);
});

test("join campaign refreshes expiring token before adding member", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const updates = [];
    const joined = [];
    const webhookPayloads = [];
    const docs = [
        {
            _id: "doc1",
            userId: "100",
            tokenField: "oauth",
            discord: { userId: "100" },
            lastVerify: { guildId: "123456789012345678", result: "success" },
            oauth: {
                encryptedAccessToken: "old-access",
                encryptedRefreshToken: "old-refresh",
                expiresAt: 1,
                scope: "identify guilds.join",
                refreshFailCount: 0
            }
        }
    ];

    const fakeTokenManager = {
        getAccessToken: async ({ userId }) => {
            t.assert.equal(userId, "100");
            updates.push({ filter: { _id: "doc1" }, update: { $set: { "oauth.encryptedAccessToken": "enc:new-access" } } });
            return {
                ok: true,
                accessToken: "new-access",
                refreshed: true,
                expiresAt: 999999,
                tokenField: "oauth",
                userId: "100"
            };
        }
    };
    const fakeDiscord = {
        getGuildMemberWithBot: async () => null,
        addMemberToGuild: async (guildId, userId, accessToken) => {
            joined.push({ guildId, userId, accessToken });
            return { ok: true, status: 201 };
        }
    };

    const summary = await joinCampaign.executeJoinCampaign({
        targetGuildId: "123456789012345678",
        targetGuildName: "Target",
        targetGuildIconUrl: "https://cdn.discordapp.com/icons/123456789012345678/icon.png",
        candidateDocs: docs,
        oauthTokenManager: fakeTokenManager,
        discordApi: fakeDiscord,
        config: {
            enabled: true,
            allowedGuilds: new Set(["123456789012345678"]),
            maxUsers: 10,
            delayMs: 0,
            progressEvery: 1,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        },
        sendStartLog: true,
        sendWebhook: async payload => {
            webhookPayloads.push(payload);
            return true;
        },
        sleep: async () => {}
    });

    t.assert.equal(summary.joined, 1);
    t.assert.equal(summary.refreshed, 1);
    t.assert.equal(summary.failed, 0);
    t.assert.equal(joined.length, 1);
    t.assert.deepEqual(joined[0], {
        guildId: "123456789012345678",
        userId: "100",
        accessToken: "new-access"
    });
    t.assert.equal(updates.length, 1);
    t.assert.equal(updates[0].update.$set["oauth.encryptedAccessToken"], "enc:new-access");
    t.assert.equal(webhookPayloads.length, 2);
    t.assert.equal(
        webhookPayloads[0].embeds[0].author.icon_url,
        "https://cdn.discordapp.com/icons/123456789012345678/icon.png"
    );
    t.assert.match(webhookPayloads[0].embeds[0].footer.text, /campaign\.join\.start/);
    t.assert.match(webhookPayloads[1].embeds[0].footer.text, /campaign\.join\.finish/);
});

test("join campaign records refresh-failure persistence results without stopping later users", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const webhookPayloads = [];
    const docs = [
        {
            _id: "refresh-fails",
            userId: "100",
            tokenField: "oauth",
            discord: { userId: "100" },
            lastVerify: { guildId: "123456789012345678", result: "success" },
            oauth: {
                encryptedAccessToken: "old-access",
                encryptedRefreshToken: "old-refresh",
                expiresAt: 1,
                scope: "identify guilds.join"
            }
        },
        {
            _id: "still-works",
            userId: "200",
            tokenField: "oauth",
            discord: { userId: "200" },
            lastVerify: { guildId: "123456789012345678", result: "success" },
            oauth: {
                encryptedAccessToken: "enc:usable-access",
                encryptedRefreshToken: "usable-refresh",
                expiresAt: Date.now() + 24 * 60 * 60 * 1000,
                scope: "identify guilds.join"
            }
        }
    ];
    const fakeTokenManager = {
        getAccessToken: async ({ userId }) => {
            if (userId === "100") {
                return {
                    ok: false,
                    failed: true,
                    code: "oauth_refresh_failed",
                    persisted: false,
                    persistenceError: "MongoDB unavailable",
                    error: new Error("refresh rejected")
                };
            }
            return {
                ok: true,
                accessToken: "usable-access",
                refreshed: false
            };
        }
    };
    const summary = await joinCampaign.executeJoinCampaign({
        targetGuildId: "123456789012345678",
        candidateDocs: docs,
        oauthTokenManager: fakeTokenManager,
        discordApi: {
            getGuildMemberWithBot: async () => null,
            addMemberToGuild: async () => ({ ok: true, status: 201 })
        },
        config: {
            enabled: true,
            allowedGuilds: new Set(["123456789012345678"]),
            delayMs: 0,
            progressEvery: 1,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        },
        sendStartLog: true,
        sendFinishLog: true,
        sendWebhook: async payload => webhookPayloads.push(payload),
        sleep: async () => {}
    });

    t.assert.equal(summary.refreshFailed, 1);
    t.assert.equal(summary.persistenceFailed, 1);
    t.assert.equal(summary.refreshStateConflicts, 0);
    t.assert.equal(summary.joined, 1);
    t.assert.equal(summary.errors.some(item => item.reason === "refresh_failure_persistence_failed"), true);
    const finishPayload = JSON.stringify(webhookPayloads.at(-1));
    t.assert.match(finishPayload, /campaign\.join\.persistence_failed/);
    t.assert.equal(finishPayload.includes("old-refresh"), false);
    t.assert.equal(finishPayload.includes("usable-access"), false);
});

test("join campaign candidate missing tokenField fails closed without guessing", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const docs = [
        {
            userId: "user-missing-field",
            oauth: { encryptedAccessToken: "valid", scope: "identify guilds.join" },
            adminOAuth: { encryptedAccessToken: "valid", scope: "identify guilds.join" }
        }
    ];

    const summary = await joinCampaign.executeJoinCampaign({
        targetGuildId: "123456789012345678",
        candidateDocs: docs,
        oauthTokenManager: {
            getAccessToken: async () => {
                t.fail("Manager getAccessToken should not be called for invalid candidate without tokenField");
            }
        },
        discordApi: {
            getGuildMemberWithBot: async () => null,
            addMemberToGuild: async () => ({ ok: true, status: 201 })
        },
        config: {
            enabled: true,
            allowedGuilds: new Set(["123456789012345678"]),
            delayMs: 0,
            progressEvery: 1,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        },
        sendStartLog: false,
        sendFinishLog: false,
        sleep: async () => {}
    });

    t.assert.equal(summary.joined, 0);
    t.assert.equal(summary.failed, 1);
    t.assert.equal(summary.tokenInvalid, 1);
    t.assert.equal(summary.errors.some(e => e.detail === "missing_or_invalid_candidate_token_field"), true);
});

test("Thai join campaign log summarizes counts without raw tokens", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const payload = joinCampaign.formatThaiJoinCampaignLog({
        campaignId: "join_test",
        targetGuildId: "123456789012345678",
        targetGuildName: "ปลายทาง",
        dryRun: false,
        status: "finished",
        scannedRecords: 10,
        uniqueUsers: 8,
        usableUsers: 7,
        joined: 5,
        alreadyMember: 1,
        failed: 1,
        refreshed: 2,
        refreshFailed: 0,
        missingScope: 1,
        tokenInvalid: 0,
        botMissingPermission: 0,
        rateLimited: 0,
        errors: [{ userId: "100", reason: "discord_error", detail: "no token value here" }]
    }, "finish");

    const text = JSON.stringify(payload);
    t.assert.match(text, /งานดึงสมาชิกเข้าเซิร์ฟเวอร์เสร็จแล้ว/);
    t.assert.match(text, /ดึงเข้าสำเร็จ/);
    t.assert.match(text, /"value":"5"/);
    t.assert.equal(text.includes("new-access"), false);
    t.assert.equal(text.includes("old-refresh"), false);
});

test("join campaign route helpers list and resolve allowed target guilds", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const oldAllowed = process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS;
    const oldEnabled = process.env.JOIN_CAMPAIGN_ENABLED;
    process.env.JOIN_CAMPAIGN_ENABLED = "true";
    process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS = "111111111111111111";

    try {
        const cache = new Map([
            ["111111111111111111", { id: "111111111111111111", name: "Allowed", memberCount: 10 }],
            ["222222222222222222", { id: "222222222222222222", name: "Blocked", memberCount: 20 }]
        ]);
        const client = { guilds: { cache } };

        const targets = listJoinCampaignTargets(client);
        t.assert.equal(targets.length, 1);
        t.assert.equal(targets[0].id, "111111111111111111");

        t.assert.equal(resolveJoinCampaignTarget(client, "111111111111111111").ok, true);
        t.assert.equal(resolveJoinCampaignTarget(client, "222222222222222222").status, 403);
        t.assert.equal(resolveJoinCampaignTarget(client, "333333333333333333").status, 403);
    } finally {
        if (oldAllowed === undefined) delete process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS;
        else process.env.JOIN_CAMPAIGN_ALLOWED_GUILDS = oldAllowed;
        if (oldEnabled === undefined) delete process.env.JOIN_CAMPAIGN_ENABLED;
        else process.env.JOIN_CAMPAIGN_ENABLED = oldEnabled;
    }
});

test("startJoinCampaign rejects disabled config before creating an active job", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    joinCampaign._test.runningState.active = null;
    joinCampaign._test.runningState.last = null;
    joinCampaign._test.runningState.stopRequested = false;

    const result = joinCampaign.startJoinCampaign({
        targetGuildId: "123456789012345678",
        config: {
            enabled: false,
            allowedGuilds: new Set(),
            maxUsers: 10,
            delayMs: 0,
            progressEvery: 10,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        }
    });

    t.assert.equal(result.ok, false);
    t.assert.equal(result.code, "CAMPAIGN_DISABLED");
    t.assert.equal(result.error, "campaign_disabled");
    t.assert.equal(joinCampaign.getJoinCampaignStatus().active, null);
});

test("join campaign is default-off and requires an explicit guild allowlist", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const defaults = joinCampaign.getJoinCampaignConfig({});
    t.assert.equal(defaults.enabled, false);
    t.assert.equal(defaults.allowedGuilds.size, 0);
    t.assert.equal(joinCampaign.isGuildAllowed("123456789012345678", {
        enabled: true,
        allowedGuilds: new Set()
    }), false);

    await t.assert.rejects(
        joinCampaign.executeJoinCampaign({
            targetGuildId: "123456789012345678",
            candidateDocs: [],
            config: {
                enabled: true,
                allowedGuilds: new Set(),
                maxUsers: 10,
                delayMs: 0,
                progressEvery: 10,
                refreshMarginMs: 60 * 60 * 1000,
                failMax: 5
            },
            sendWebhook: async () => true
        }),
        error => error?.code === "CAMPAIGN_ALLOWLIST_REQUIRED" && error?.status === 503
    );
});

test("join campaign follows database cursor batches until every OAuth user is scanned", async (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const calls = [];
    const batches = [
        [
            { _id: "1", discord: { userId: "100" }, lastVerify: { guildId: "123456789012345678", result: "success" }, oauth: { encryptedRefreshToken: "a", scope: "guilds.join" } },
            { _id: "2", discord: { userId: "200" }, lastVerify: { guildId: "123456789012345678", result: "success" }, oauth: { encryptedRefreshToken: "b", scope: "guilds.join" } }
        ],
        [{ _id: "3", discord: { userId: "200" }, lastVerify: { guildId: "123456789012345678", result: "success" }, oauth: { encryptedRefreshToken: "duplicate", scope: "guilds.join" } }]
    ];
    const model = {
        find(filter) {
            calls.push(filter);
            const docs = batches.shift() || [];
            const query = {
                select: () => query,
                sort: () => query,
                limit: () => query,
                lean: async () => docs
            };
            return query;
        }
    };
    const summary = await joinCampaign.executeJoinCampaign({
        targetGuildId: "123456789012345678",
        OAuthUserModel: model,
        dryRun: true,
        config: {
            enabled: true,
            allowedGuilds: new Set(["123456789012345678"]),
            batchSize: 2,
            delayMs: 0,
            progressEvery: 10,
            refreshMarginMs: 60 * 60 * 1000,
            failMax: 5
        },
        sendWebhook: async () => true
    });

    t.assert.equal(summary.scannedRecords, 3);
    t.assert.equal(summary.uniqueUsers, 2);
    t.assert.equal(summary.usableUsers, 2);
    t.assert.equal(summary.missingScope, 0);
    t.assert.equal(summary.batches, 2);
    t.assert.equal(calls.length, 2);
    t.assert.deepEqual(calls[1].$and.at(-1), { _id: { $gt: "2" } });
});

test("join campaign has no Sync Roles UI or route surface", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const runtimeSurface = [
        fs.readFileSync("discord/index/joinCampaignPage.js", "utf8"),
        fs.readFileSync("discord/index/joinCampaignRoutes.js", "utf8"),
        fs.readFileSync("discord/features/joinCampaign.js", "utf8"),
        fs.readFileSync("discord/verification/guildPage.js", "utf8"),
        fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8"),
        fs.readFileSync("discord/verification/routes/guild.js", "utf8")
    ].join("\n");

    t.assert.equal(/sync-roles/i.test(runtimeSurface), false);
    t.assert.equal(/syncRoles/.test(runtimeSurface), false);
    t.assert.equal(/Sync Roles/.test(runtimeSurface), false);
});

test("join campaign confirmation stays bound to the guild captured before dry-run", (t) => { // NOSONAR -- node:test assertions are not recognized by S2699.
    const source = fs.readFileSync("discord/index/joinCampaignPage.js", "utf8");
    const start = source.indexOf("async function startCampaign()");
    const capturedName = source.indexOf("const guildName=", start);
    const dryRun = source.indexOf("await api('/api/join-campaign/dry-run'", start);
    const selectionGuard = source.indexOf("if(selectedGuildId() !== guildId)", dryRun);
    const confirmation = source.indexOf("window.confirm", dryRun);

    t.assert.ok(start >= 0);
    t.assert.ok(capturedName > start && capturedName < dryRun);
    t.assert.ok(selectionGuard > dryRun && selectionGuard < confirmation);
});
