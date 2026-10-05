"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const modeRegistry = require("../features/joinCampaign/modes/modeRegistry");
const { buildBaseSetupModal, buildStartOptionsModal, CUSTOM_IDS } = require("../features/joinCampaign/ui/modals");
const { buildPanelPayload, IDS: PANEL_IDS } = require("../features/joinCampaign/ui/panelBuilder");
const { buildPreflightConfirmationPayload, IDS: CONFIRM_IDS } = require("../features/joinCampaign/ui/confirmationBuilder");
const joinCampaignService = require("../features/joinCampaign/services/joinCampaignService");
const { isJoinCampaignInteraction } = require("../features/joinCampaign/handlers/interactionRouter");
const database = require("../../database/index");

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
