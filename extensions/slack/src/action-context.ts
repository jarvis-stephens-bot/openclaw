import type { WebClient } from "@slack/web-api";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SlackReplyDeliveryMessage } from "./reply-blocks.js";

export type SlackActionClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  teamId?: string;
  client?: WebClient;
  assertDirectAdapterHandoff?: () => void;
};

export type SlackActionContext = {
  conversationReadOrigin?: ChannelMessageActionContext["conversationReadOrigin"];
  requesterAccountId?: string;
  requesterSenderId?: string;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sameChannelThreadRequired?: boolean;
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  assertDirectAdapterHandoff?: ChannelMessageActionContext["assertDirectAdapterHandoff"];
  preparedMessages?: readonly SlackReplyDeliveryMessage[];
};
