import org.cortico.minecraft.CorticoChatFilter;

public final class ChatFilterCheck {
    public static void main(String[] args) {
        String[] receipts = {
            "MC_PROTECTION {\"schemaVersion\":1,\"allowed\":true}",
            "  §7MC_PROTECT {\"allowed\":false,\"reason\":\"claimed\"}",
            "MC_DUNGEON {\"type\":\"state\"}",
            "MC_STATUS_V2\t{\"mana\":48}"
        };
        String[] visible = {
            "<Example> 你好，一起去探索吗？",
            "MC_PROTECTION 是什么意思？",
            "任务完成，奖励已存入个人箱子。",
            "权限不足，不能破坏这里。",
            "魔力 48/48",
            "{\"message\":\"普通 JSON 消息\"}",
            "这里出现了 MC_PROTECTION {\"allowed\":true}",
            "MC_PROTECTION_MANUAL 说明",
            ""
        };
        for (String text : receipts) {
            if (!CorticoChatFilter.isMachineMessage(text)) throw new AssertionError("Receipt visible: " + text);
        }
        for (String text : visible) {
            if (CorticoChatFilter.isMachineMessage(text)) throw new AssertionError("Normal message hidden: " + text);
        }
        System.out.println("Chat filter checks passed: " + (receipts.length + visible.length));
    }
}
