"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const modeRegistry = require("../features/joinCampaign/modes/modeRegistry");
const { buildBaseSetupModal, buildStartOptionsModal, CUSTOM_IDS } = require("../features/joinCampaign/ui/modals");
const { buildPanelPayload, IDS: PANEL_IDS } = require("../features/joinCampaign/ui/panelBuilder");
const { buildPreflightConfirmationPayload, IDS: CONFIRM_IDS } = require("../features/joinCampaign/ui/confirmationBuilder");
const joinCampaignService = require("../features/joinCampaign/services/joinCampaignService");
const { isJoinCampaignInteraction } = require("../features/joinCampaign/handlers/interactionRouter");
const { isValidDiscordWebhookUrl } = require("../features/joinCampaign/worker/batchLogger");
const { runPreflight } = require("../features/joinCampaign/services/preflightService");
const campaignWorker = require("../features/joinCampaign/worker/campaignWorker");
const { runStartupRecovery } = require("../features/joinCampaign/recovery/startupRecovery");
const database = require("../../database/index");

test.beforeEach(() => {
    try {
        const repo = database.repositories.joinCampaign;
        repo.db.prepare("DELETE FROM join_campaign_jobs").run();
        repo.db.prepare("DELETE FROM join_campaign_items").run();
    } catch (_) {}
});

test.after(() => {
    try {
        const repo = database.repositories.joinCampaign;
        repo.db.prepare("DELETE FROM join_campaign_jobs").run();
        repo.db.prepare("DELETE FROM join_campaign_items").run();
    } catch (_) {}
});

test("Join Campaign: Mode registry lists modes and retrieves by id", () => {
    const modes = modeRegistry.listModes();
    assert.ok(modes.length >= 2);
    
    const allMode = modeRegistry.getMode("ALL_TO_TARGET");
    assert.equal(allMode.id, "ALL_TO_TARGET");
    assert.equal(allMode.requiresSource, false);

    const g2gMode = modeRegistry.getMode("GUILD_TO_GUILD");
    assert.equal(g2gMode.id, "GUILD_TO_GUILD");
    assert.equal(g2gMode.requiresSource, true);

    const fallback = modeRegistry.getMode("NON_EXISTENT_MODE");
    assert.equal(fallback.id, "ALL_TO_TARGET");
});

test("Join Campaign: Modals generate valid Discord Components", () => {
    const allMode = modeRegistry.getMode("ALL_TO_TARGET");
    const setupModalAll = buildBaseSetupModal({ mode: allMode, currentState: { targetGuildId: "123456789012345678" } });
    assert.ok(setupModalAll.data.custom_id.startsWith(CUSTOM_IDS.MODAL_SETUP_PREFIX));
    assert.equal(setupModalAll.components.length, 1); // Only target guild input

    const g2gMode = modeRegistry.getMode("GUILD_TO_GUILD");
    const setupModalG2G = buildBaseSetupModal({ mode: g2gMode, currentState: {} });
    assert.equal(setupModalG2G.components.length, 2); // Target and source guild inputs

    const startModal = buildStartOptionsModal();
    assert.equal(startModal.data.custom_id, CUSTOM_IDS.MODAL_START);
    assert.equal(startModal.components.length, 2); // requested_amount and webhook_url
});

test("Join Campaign: Panel builder constructs embed and rows reflecting state", () => {
    const allMode = modeRegistry.getMode("ALL_TO_TARGET");
    const payloadIdle = buildPanelPayload({
        mode: allMode,
        panelState: {
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678"
        },
        readyCount: 120,
        targetGuildName: "Target Server"
    });
    assert.ok(payloadIdle.embeds.length === 1);
    assert.ok(payloadIdle.components.length === 2);
    
    // Start button is enabled when idle
    const buttonRow = payloadIdle.components[1];
    assert.equal(buttonRow.components[0].data.disabled, false);

    const payloadRunning = buildPanelPayload({
        mode: allMode,
        panelState: {
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678"
        },
        liveJob: {
            status: "RUNNING",
            joinedCount: 15,
            requestedAmount: 50
        },
        targetGuildName: "Target Server"
    });
    // Start button is disabled when running
    const runningButtonRow = payloadRunning.components[1];
    assert.equal(runningButtonRow.components[0].data.disabled, true);
    assert.match(payloadRunning.embeds[0].data.fields.find(f => f.name.includes("สถานะ")).value, /กำลังดึงสมาชิก/);
});

test("Join Campaign: Confirmation builder formats ephemeral confirmation with single confirm button", () => {
    const payload = buildPreflightConfirmationPayload({
        stageId: "stage_test_123",
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        targetGuildId: "123456789012345678",
        targetGuildName: "Target Guild",
        readyCount: 85,
        requestedQuota: 50,
        hasWebhook: false
    });

    assert.ok(payload.embeds.length === 1);
    assert.ok(payload.components.length === 1);
    const confirmButton = payload.components[0].components[0];
    assert.equal(confirmButton.data.custom_id, `${CONFIRM_IDS.BTN_CONFIRM_PREFIX}stage_test_123`);
    assert.match(confirmButton.data.label, /ยืนยัน/);
});

test("Join Campaign: isJoinCampaignInteraction detects subsystem IDs", () => {
    assert.equal(isJoinCampaignInteraction({ customId: PANEL_IDS.SELECT_MODE }), true);
    assert.equal(isJoinCampaignInteraction({ customId: PANEL_IDS.BTN_START }), true);
    assert.equal(isJoinCampaignInteraction({ customId: `${CONFIRM_IDS.BTN_CONFIRM_PREFIX}abc` }), true);
    assert.equal(isJoinCampaignInteraction({ customId: `${CUSTOM_IDS.MODAL_SETUP_PREFIX}ALL_TO_TARGET` }), true);
    assert.equal(isJoinCampaignInteraction({ customId: CUSTOM_IDS.MODAL_START }), true);
    assert.equal(isJoinCampaignInteraction({ customId: "unrelated_button" }), false);
});

test("Join Campaign: SQLite Repository persists panel and jobs", async () => {
    const repo = database.repositories.joinCampaign;
    assert.ok(repo, "JoinCampaignRepository must be available on database singleton");

    const channelId = `test_ch_${Date.now()}`;
    const panel = repo.savePanelState({
        channelId,
        guildId: "111111111111111111",
        messageId: "222222222222222222",
        mode: "ALL_TO_TARGET",
        targetGuildId: "333333333333333333",
        targetGuildName: "Test Target",
        readyCount: 42
    });
    assert.ok(panel);

    const found = repo.findPanelByChannelId(channelId);
    assert.equal(found.channelId, channelId);
    assert.equal(found.targetGuildId, "333333333333333333");
    assert.equal(found.readyCount, 42);

    // Job Lifecycle in SQLite
    const testJobId = `job_${Date.now()}`;
    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "333333333333333333",
        targetGuildName: "Test Target",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 42,
        joinedCount: 0,
        alreadyCount: 0,
        failedCount: 0
    });
    assert.equal(job.id, testJobId);
    assert.equal(job.status, "RUNNING");

    const active = repo.getActiveJob();
    assert.ok(active);
    assert.equal(active.id, testJobId);

    // Update Progress
    repo.updateJobProgress(testJobId, {
        joinedCount: 5,
        alreadyCount: 1,
        failedCount: 0
    });
    const updated = repo.findJobById(testJobId);
    assert.equal(updated.joinedCount, 5);

    // Complete Job
    repo.markJobCompleted(testJobId);
    const completed = repo.findJobById(testJobId);
    assert.equal(completed.status, "COMPLETED");
    assert.ok(completed.completedAt);

    // Active job should now be null
    assert.equal(repo.getActiveJob(), null);
});

test("Join Campaign: isValidDiscordWebhookUrl strictly validates Discord webhook patterns", () => {
    assert.equal(isValidDiscordWebhookUrl("https://discord.com/api/webhooks/123456789012345678/abcdef-ghijklmn"), true);
    assert.equal(isValidDiscordWebhookUrl("https://discordapp.com/api/webhooks/123456789012345678/abcdef_ghijklmn-123"), true);
    assert.equal(isValidDiscordWebhookUrl("https://canary.discord.com/api/webhooks/123456789012345678/abc-def"), true);
    assert.equal(isValidDiscordWebhookUrl("https://ptb.discord.com/api/webhooks/123456789012345678/abc-def"), true);
    
    // SSRF & Arbitrary URL Rejections
    assert.equal(isValidDiscordWebhookUrl("http://discord.com/api/webhooks/123/abc"), false); // Insecure HTTP
    assert.equal(isValidDiscordWebhookUrl("https://evil.com/api/webhooks/123/abc"), false); // Non-discord host
    assert.equal(isValidDiscordWebhookUrl("https://127.0.0.1/api/webhooks/123/abc"), false); // Localhost IP
    assert.equal(isValidDiscordWebhookUrl("https://169.254.169.254/api/webhooks/123/abc"), false); // Cloud metadata IP
    assert.equal(isValidDiscordWebhookUrl("https://discord.com.attacker.com/api/webhooks/123/abc"), false); // Spoofed domain
    assert.equal(isValidDiscordWebhookUrl(""), false);
    assert.equal(isValidDiscordWebhookUrl(null), false);
});

test("Join Campaign: Preflight sets requestedQuota accurately without clamping to readyCount", async () => {
    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    memberCount: 5,
                    members: {
                        cache: new Map([["bot_id", { id: "bot_id" }]]),
                        fetch: async () => new Map([["user_already_in", { id: "user_already_in" }]]),
                        me: {
                            permissions: {
                                has: () => true
                            }
                        }
                    }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "user_1" } },
            { discord: { userId: "user_2" } }
        ]
    };

    // When requestedAmount is 100 and readyCount is 2: requestedQuota must be 100 (NOT clamped to 2)
    const preflight = await runPreflight({
        client: mockClient,
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        baseConfig: { targetGuildId: "123456789012345678" },
        requestedAmount: 100,
        tokenManager: mockTokenManager,
        config: { enabled: true, allowedGuilds: new Set() }
    });

    assert.equal(preflight.ok, true);
    assert.equal(preflight.readyCount, 2);
    assert.equal(preflight.requestedQuota, 100);

    // When requestedAmount is not provided, defaults to readyCount
    const preflightDefault = await runPreflight({
        client: mockClient,
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        baseConfig: { targetGuildId: "123456789012345678" },
        requestedAmount: null,
        tokenManager: mockTokenManager,
        config: { enabled: true, allowedGuilds: new Set() }
    });

    assert.equal(preflightDefault.ok, true);
    assert.equal(preflightDefault.requestedQuota, 2);
});

test("Join Campaign: Startup recovery increments recovery_count and releases expired leases", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `rec_job_${Date.now()}`;
    
    // Create an interrupted job
    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        targetGuildName: "Recovery Target",
        status: "RUNNING",
        requestedAmount: 50,
        selectedAmount: 50,
        joinedCount: 10,
        recoveryCount: 0
    });

    // Enqueue an item and lease it
    repo.createItems(testJobId, [{ userId: "cand_leased", tokenField: "oauth" }]);
    const item = repo.claimNextPendingItem(testJobId, 30000);
    assert.ok(item);
    assert.equal(item.status, "processing");

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Recovery Target",
                    memberCount: 1,
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({ candidates: [], hasMore: false }),
        getAccessToken: async () => null
    };

    const recoveryResult = await runStartupRecovery({
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager
    });

    assert.equal(recoveryResult.recovered, true);
    assert.equal(recoveryResult.jobId, testJobId);

    // Check that recovery_count was incremented in DB
    const updatedJob = repo.findJobById(testJobId);
    assert.equal(updatedJob.recoveryCount, 1);

    // Wait for resumed worker to complete and clean up job
    await campaignWorker.waitForCompletion();
    repo.markJobCompleted(testJobId);
});

test("Join Campaign: Adaptive worker halts immediately on Discord Guild Full error 30005", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `guild_full_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        targetGuildName: "Full Guild",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 10,
        joinedCount: 0
    });

    // Mock candidates
    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "user_full_1" }, tokenField: "oauth" }
        ],
        getAccessToken: async () => ({ accessToken: "mock_token" })
    };

    // Discord API returns error 30005 (Maximum number of guild members reached)
    const mockDiscordApi = {
        addMemberToGuild: async () => ({
            ok: false,
            status: 400,
            error: {
                code: 30005,
                message: "Maximum number of guild members reached (250000)"
            }
        })
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Full Guild"
                }]
            ])
        }
    };

    await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        discord: mockDiscordApi
    });

    await campaignWorker.waitForCompletion();

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.status, "SERVER_FULL");
    assert.match(finishedJob.lastError, /เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว/);
});

test("Join Campaign: Adaptive worker skips members already in target guild without calling API", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `skip_test_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        targetGuildName: "Skip Target",
        status: "RUNNING",
        requestedAmount: 1,
        selectedAmount: 2,
        joinedCount: 0
    });

    let apiCalls = 0;
    const mockDiscordApi = {
        addMemberToGuild: async () => {
            apiCalls++;
            return { ok: true, status: 201 };
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "already_here_user" }, tokenField: "oauth" },
            { discord: { userId: "new_user" }, tokenField: "oauth" }
        ],
        getAccessToken: async () => ({ accessToken: "mock_token" })
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Skip Target"
                }]
            ])
        }
    };

    // Pre-seed targetMemberIds with already_here_user
    const targetMemberIds = new Set(["already_here_user"]);

    await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        discord: mockDiscordApi,
        targetMemberIds
    });

    await campaignWorker.waitForCompletion();

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.joinedCount, 1);
    assert.equal(finishedJob.alreadyCount, 1);
    // Only new_user should have called addMemberToGuild
    assert.equal(apiCalls, 1);
});
