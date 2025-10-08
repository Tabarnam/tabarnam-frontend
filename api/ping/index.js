// api/ping/index.js - simple health probe
import { app } from "@azure/functions";

app.http("ping", {
  route: "ping",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async () => ({
    status: 200,
    jsonBody: { ok: true, name: "ping" }
  })
});
