export interface SlackAppManifest {
  _metadata: {
    major_version: number;
    minor_version: number;
  };
  display_information: {
    name: string;
    description: string;
    background_color: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    slash_commands: Array<{
      command: string;
      url: string;
      description: string;
      usage_hint: string;
      should_escape: boolean;
    }>;
  };
  oauth_config: {
    scopes: {
      bot: string[];
    };
    redirect_urls: string[];
  };
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
    };
    interactivity: {
      is_enabled: boolean;
      request_url: string;
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export interface SlackAppManifestInput {
  baseUrl: string;
  botScopes: string[];
  appName?: string | undefined;
  botDisplayName?: string | undefined;
  description?: string | undefined;
  backgroundColor?: string | undefined;
  redirectUrl?: string | undefined;
  eventRequestUrl?: string | undefined;
  interactivityRequestUrl?: string | undefined;
  slashCommandUrl?: string | undefined;
  slashCommand?: string | undefined;
  botEvents?: string[] | undefined;
}

export const defaultSlackBotEvents = [
  "app_uninstalled",
  "app_mention",
  "tokens_revoked",
  "reaction_added",
  "member_joined_channel",
  "member_left_channel",
] as const;

export function buildSlackAppManifest(
  input: SlackAppManifestInput,
): SlackAppManifest {
  const baseUrl = normalizeSlackManifestBaseUrl(input.baseUrl);
  const eventRequestUrl =
    input.eventRequestUrl ?? slackManifestUrl(baseUrl, "/api/slack/events");
  const interactivityRequestUrl =
    input.interactivityRequestUrl ??
    slackManifestUrl(baseUrl, "/api/slack/interactivity");
  const slashCommandUrl =
    input.slashCommandUrl ?? slackManifestUrl(baseUrl, "/api/slack/commands");
  const redirectUrl =
    input.redirectUrl ?? slackManifestUrl(baseUrl, "/api/slack/oauth/callback");
  return {
    _metadata: {
      major_version: 2,
      minor_version: 1,
    },
    display_information: {
      name: input.appName?.trim() || "Bek",
      description:
        input.description?.trim() ||
        "Open-source AI teammate for governed Slack work.",
      background_color: input.backgroundColor?.trim() || "#111827",
    },
    features: {
      bot_user: {
        display_name: input.botDisplayName?.trim() || "bek",
        always_online: true,
      },
      slash_commands: [
        {
          command: input.slashCommand?.trim() || "/bek",
          url: slashCommandUrl,
          description: "Ask Bek to work from this channel.",
          usage_hint: "what can you access here?",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: uniqueNonEmptyStrings(input.botScopes),
      },
      redirect_urls: [redirectUrl],
    },
    settings: {
      event_subscriptions: {
        request_url: eventRequestUrl,
        bot_events: uniqueNonEmptyStrings([
          ...(input.botEvents ?? defaultSlackBotEvents),
        ]),
      },
      interactivity: {
        is_enabled: true,
        request_url: interactivityRequestUrl,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

function normalizeSlackManifestBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Slack manifest base URL is required.");
  }
  const url = new URL(trimmed);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function slackManifestUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString();
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}
