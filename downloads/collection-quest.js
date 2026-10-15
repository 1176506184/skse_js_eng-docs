import Skyrim from "@skse/Skyrim.esm";

// 完整示例：接取委托 → 收集 → 实际交付 → 单独领取奖励。
// 改为 false 后去掉“领取测试山花”选项，使用世界中的正常物品。
const DEMO_ITEMS = true;
const TASK_ID = "demo.blue-flowers.v1";
const NPC_KEY = "demo.blue-flowers.npc";
const RECEIPT_KEY = "demo.blue-flowers.receipt";
const REQUIRED = 3, REWARD = 50;

skse.onMounted(() => {
    const player = skse.player[0];
    const flower = Skyrim.getForm("0x077E1C"); // MountainFlower01Blue，蓝色山花
    const gold = Skyrim.getForm("0x00000F");   // Gold001，金币
    if (!flower || !gold) { skse.console.error("[委托] 原版物品不存在"); return; }

    let hero = skse.Storage.get(NPC_KEY);
    const spawned = !hero;
    if (!hero) {
        hero = skse.new({ formId: "0x001034E4" }); // WEFarmerMale
        if (!hero) return;
        const position = player.position;
        if (!position || !hero.setPosition({ ...position, x: position.x + 120 })) return;
        skse.Storage.set(NPC_KEY, hero);
    }
    let task = skse.Tasks.get(TASK_ID);
    const inventoryListeners = [];
    function stopInventoryListeners() { inventoryListeners.splice(0).forEach(off => off()); }
    function note(message) { skse.console.log("[委托]", message); }
    function error(message) { skse.console.error("[委托]", message); }
    function receipt() { return skse.Storage.get(RECEIPT_KEY); }
    function saveReceipt(value) { skse.Storage.set(RECEIPT_KEY, value); }
    function bindTask() {
        task = player.addTask({
            id: TASK_ID,
            title: "旅人的山花委托",
            description: "帮旅人收集 3 朵蓝色山花，交付后领取 50 金币。",
            steps: [
                { title: "收集蓝色山花", total: REQUIRED },
                { title: "与旅人交谈并交付山花" },
                { title: "与旅人交谈并领取 50 金币" },
            ],
            onComplete: () => { stopInventoryListeners(); note("任务完成，已领取 50 金币。保存游戏即可保留进度。"); },
            onFail: ({ reason }) => { stopInventoryListeners(); error("任务失败：" + reason); },
            onCancel: () => { stopInventoryListeners(); note("任务已取消。"); },
        });
    }
    function syncCollection() {
        if (!task || task.state !== "active" || task.currentStep !== 0) return;
        const count = player.getItemCount(flower);
        if (!Number.isInteger(count)) { error("无法读取山花数量"); return; }
        task.steps[0].setProgress(count);
        note("山花 " + Math.min(count, REQUIRED) + "/" + REQUIRED);
        if (task.currentStep === 1) note("已收集齐，请与旅人交谈交付。");
    }
    function resumeSettlement() {
        const saved = receipt();
        if (!task || task.state !== "active" || !saved) return;
        // 只恢复已确认成功的记账，不重新转交或发钱。
        if ((saved.phase === "delivered" || saved.phase === "rewarded") && task.currentStep === 1) task.steps[1].complete();
        if (saved.phase === "rewarded" && task.currentStep === 2) task.steps[2].complete();
    }
    function unresolved() {
        const phase = receipt()?.phase;
        return phase && phase !== "delivered" && phase !== "rewarded" && phase !== "transferRetry";
    }
    function deliver() {
        if (!task || task.state !== "active" || task.currentStep !== 1 || unresolved()) return;
        const before = player.getItemCount(flower), targetBefore = hero.getItemCount(flower);
        if (!Number.isInteger(before) || !Number.isInteger(targetBefore)) { error("无法读取交付双方背包"); return; }
        if (before < REQUIRED) { note("背包中的山花不够，请补齐后交付。"); return; }
        const pending = { phase: "transferPending", before, targetBefore, count: REQUIRED };
        // 先写收据。若调用/后续存储出错，保留 pending，禁止盲目再次扣物品。
        saveReceipt(pending);
        const moved = player.giveItem(hero, flower, REQUIRED);
        const after = player.getItemCount(flower), targetAfter = hero.getItemCount(flower);
        if (moved === REQUIRED && after === before - REQUIRED && targetAfter === targetBefore + REQUIRED) {
            saveReceipt({ phase: "delivered" });
            task.steps[1].complete();
            note("山花已交给旅人，再次交谈即可领取奖励。");
        } else if (moved === 0 && before === after && targetBefore === targetAfter) {
            // 原生引擎拒绝且两边背包未变，可安全再试。
            saveReceipt({ ...pending, phase: "transferRetry" });
            error("引擎未完成交付；本次未扣物品，下次交谈可以重试。");
        } else {
            saveReceipt({ ...pending, phase: "transferUncertain", moved, after, targetAfter });
            error("交付数量异常，已暂停结算。请检查日志和收据，不要重复扣除。");
        }
    }
    function claimReward() {
        if (!task || task.state !== "active" || task.currentStep !== 2 || receipt()?.phase !== "delivered") return;
        const before = player.getItemCount(gold);
        if (!Number.isInteger(before)) { error("无法读取金币数量"); return; }
        saveReceipt({ phase: "rewardPending", before, count: REWARD });
        player.addItem(gold, REWARD);
        const after = player.getItemCount(gold);
        if (after === before + REWARD) {
            saveReceipt({ phase: "rewarded" });
            task.steps[2].complete();
        } else if (after === before) {
            saveReceipt({ phase: "delivered" });
            error("引擎未发出金币，下次交谈可以重试。");
        } else {
            saveReceipt({ phase: "rewardUncertain", before, after, count: REWARD });
            error("金币数量异常，已暂停发奖，请检查收据。");
        }
    }
    // 所有 option 均在原生菜单关闭后执行，避免背包操作与 UI 退出相互干扰。
    function say(topicText, options = [{ text: "再见。" }]) {
        hero.setTopic({ target: player, topics: [{ topicText, options }] });
    }
    function showConversation() {
        if (hero.isDead || player.isDead) return;
        resumeSettlement();
        if (!task) {
            say("旅人：能帮我收集 3 朵蓝色山花吗？交给我后，我给你 50 金币。", [
                { text: "交给我吧。", onSelect: () => { bindTask(); syncCollection(); note("已接取任务。与旅人交谈可查看进度。"); } },
                { text: "暂时没空。" },
            ]);
            return;
        }
        if (task.state !== "active") {
            say(task.state === "completed" ? "旅人：山花收到了，50 金币也给你了，谢谢！" : "这份委托已经结束。原因：" + task.reason);
            return;
        }
        if (receipt()?.phase === "transferRetry") {
            say("旅人：上次没有交付成功，要再试一次吗？", [
                { text: "重新交付。", onSelect: deliver },
                { text: "稍后再来。" },
            ]);
            return;
        }
        if (unresolved()) {
            say("结算被中断或数量异常，已暂停自动重试。请查看 SkyrimJS.log 与 Storage 收据。", [{ text: "我先核对一下。" }]);
            error("结算待核对：" + JSON.stringify(receipt()));
            return;
        }
        syncCollection();
        if (task.currentStep === 0) {
            const options = [{ text: "我继续找找。" }];
            if (DEMO_ITEMS) options.push({ text: "演示：领取 1 朵测试山花。", onSelect: () => player.addItem(flower, 1) });
            say("旅人：蓝色山花收集了 " + player.getItemCount(flower) + "/" + REQUIRED + " 朵。", options);
        } else if (task.currentStep === 1) {
            const count = player.getItemCount(flower);
            say(count >= REQUIRED ? "旅人：山花带齐了？交给我后，再来领取报酬吧。" : "旅人：背包里只剩 " + count + " 朵，请补齐 3 朵再交付。", [
                ...(count >= REQUIRED ? [{ text: "交付 3 朵蓝色山花。", onSelect: deliver }] : []),
                { text: "稍后再来。" },
            ]);
        } else {
            say("旅人：谢谢你的山花，这是约好的 50 金币。", [
                { text: "领取 50 金币。", onSelect: claimReward },
                { text: "稍后再领。" },
            ]);
        }
    }
    if (task) { bindTask(); resumeSettlement(); syncCollection(); }
    if (hero.isDead) { if (task?.state === "active") task.fail("委托人已死亡"); return; }
    const onInventory = e => { if (e.itemFormId === flower.formId) syncCollection(); };
    if (!task || task.state === "active") inventoryListeners.push(player.on("itemAdded", onInventory), player.on("itemRemoved", onInventory));
    hero.on("death", () => { if (task?.state === "active") task.fail("委托人已死亡"); });
    hero.on("activate", e => {
        if (e.activatorFormId === player.formId) showConversation();
    });
    if (spawned && !task) setTimeout(showConversation, 1500);
    note("示例已就绪，与玩家旁边的旅人交谈。任务状态：" + (task?.state || "尚未接取"));
});
