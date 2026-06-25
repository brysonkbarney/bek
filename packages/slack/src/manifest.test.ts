import { describe, expect, it } from "vitest";
import { buildSlackAppManifest } from "./manifest";

describe("Slack app manifest", () => {
  it("builds a complete Bek Slack manifest from a public API URL", () => {
    const manifest = buildSlackAppManifest({
      baseUrl: " https://bek.example.com/// ",
      botScopes: [
        "app_mentions:read",
        "reactions:read",
        "commands",
        "chat:write",
        "channels:read",
        "commands",
      ],
    });

    expect(manifest).toMatchObject({
      _metadata: { major_version: 2, minor_version: 1 },
      display_information: {
        name: "Bek",
        description: "Open-source AI teammate for governed Slack work.",
      },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: "bek", always_online: true },
        slash_commands: [
          {
            command: "/bek",
            url: "https://bek.example.com/api/slack/commands",
            should_escape: false,
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "reactions:read",
            "commands",
            "chat:write",
            "channels:read",
          ],
        },
        redirect_urls: ["https://bek.example.com/api/slack/oauth/callback"],
      },
      settings: {
        event_subscriptions: {
          request_url: "https://bek.example.com/api/slack/events",
          bot_events: [
            "app_uninstalled",
            "app_mention",
            "tokens_revoked",
            "reaction_added",
            "message.im",
            "member_joined_channel",
            "member_left_channel",
          ],
        },
        interactivity: {
          is_enabled: true,
          request_url: "https://bek.example.com/api/slack/interactivity",
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  it("honors explicit Slack URLs for deployed reverse proxies", () => {
    const manifest = buildSlackAppManifest({
      baseUrl: "https://internal.example.com",
      botScopes: ["commands"],
      redirectUrl: "https://public.example.com/slack/oauth/callback",
      eventRequestUrl: "https://public.example.com/slack/events",
      interactivityRequestUrl: "https://public.example.com/slack/actions",
      slashCommandUrl: "https://public.example.com/slack/commands",
    });

    expect(manifest.oauth_config.redirect_urls).toEqual([
      "https://public.example.com/slack/oauth/callback",
    ]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://public.example.com/slack/events",
    );
    expect(manifest.settings.interactivity.request_url).toBe(
      "https://public.example.com/slack/actions",
    );
    expect(manifest.features.slash_commands[0]?.url).toBe(
      "https://public.example.com/slack/commands",
    );
  });
});
