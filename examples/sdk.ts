import { AvatarStageClient } from "cortico-world-avatar-stage/sdk";
const client = new AvatarStageClient("http://127.0.0.1:18431", (event) =>
  console.log(event),
);
await client.start();
try {
  const action = await client.invoke(
    "avatar_control",
    {
      action: "perform",
      gesture: "wave",
      durationMs: 2000,
    },
    "stable-greeting-001",
  );
  console.log(await client.wait(String(action.id), { timeoutMs: 15000 }));
} finally {
  await client.stop();
}
