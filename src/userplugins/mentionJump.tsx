/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, update } from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import {
    ChannelStore, FluxDispatcher, MessageActions, NavigationRouter, RestAPI, SelectedChannelStore, showToast,
    SnowflakeUtils, useEffect, UserStore, useState, useStateFromStores
} from "@webpack/common";

const ToolbarIcon = findComponentByCodeLazy("tooltipPosition:", '"aria-haspopup":', '"data-jump-section":');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 25;

interface Mention {
    id: string;
    channel_id: string;
}

interface IncomingMessage extends Mention {
    author?: { id: string; };
    mentions?: { id: string; }[];
    mention_everyone?: boolean;
    mention_roles?: string[];
}

async function fetchMentions(scopeId: string, guildId: string | undefined, userId: string): Promise<Mention[]> {
    if (guildId) {
        const { body } = await RestAPI.get({
            url: "/users/@me/mentions",
            query: { guild_id: guildId, limit: LIMIT, roles: true, everyone: true }
        });
        if (!Array.isArray(body)) throw new Error("Discord did not return server mentions");
        return body;
    }

    const { body } = await RestAPI.get({
        url: `/channels/${scopeId}/messages/search`,
        query: {
            mentions: userId, min_id: SnowflakeUtils.fromTimestamp(Date.now() - WEEK),
            limit: LIMIT, sort_by: "timestamp", sort_order: "desc"
        }
    });
    if (!Array.isArray(body?.messages)) throw new Error("Discord is still indexing this conversation");

    return (body.messages as (Mention & { hit?: boolean; })[][])
        .flat()
        .filter(message => message.hit !== false && message.channel_id === scopeId);
}

function MentionButton({ scopeId, guildId, userId }: { scopeId: string; guildId?: string; userId: string; }) {
    const storageKey = `MentionJump:visited:${userId}`;
    const [visited, setVisited] = useState<string[]>([]);
    const [mentions, setMentions] = useState<Mention[]>([]);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let request = 0;
        const deleted = new Set<string>();

        async function refresh() {
            const currentRequest = ++request;
            try {
                const [rows, saved] = await Promise.all([
                    fetchMentions(scopeId, guildId, userId),
                    get<string[]>(storageKey).catch(() => undefined)
                ]);
                if (!active || currentRequest !== request) return;
                setVisited(current => Array.from(new Set([...current, ...(saved ?? [])])));
                setMentions(current => {
                    const cutoff = SnowflakeUtils.fromTimestamp(Date.now() - WEEK);
                    const byId = new Map<string, Mention>();
                    // Keep live group DM mentions while Discord search indexes the new message.
                    for (const row of [...(guildId ? [] : current), ...rows]) {
                        if (row.id > cutoff && !deleted.has(row.id)) byId.set(row.id, row);
                    }
                    return [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, LIMIT);
                });
                setStatus("ready");
            } catch {
                if (active && currentRequest === request) setStatus("error");
            }
        }

        function onMessage({ message }: { message: IncomingMessage; }) {
            if (message.author?.id === userId) return;
            const direct = message.mentions?.some(user => user.id === userId);
            if (guildId) {
                if (!direct && !message.mention_everyone && !message.mention_roles?.length) return;
                if (ChannelStore.getChannel(message.channel_id)?.getGuildId() !== guildId) return;
                clearTimeout(timer);
                timer = setTimeout(() => void refresh(), 750);
            } else if (direct && message.channel_id === scopeId) {
                const { id, channel_id } = message;
                setMentions(current => current.some(row => row.id === id) ? current : [{ id, channel_id }, ...current].slice(0, LIMIT));
            }
        }

        function onDelete({ id, channelId }: { id: string; channelId: string; }) {
            const inScope = guildId ? ChannelStore.getChannel(channelId)?.getGuildId() === guildId : channelId === scopeId;
            if (!inScope) return;
            deleted.add(id);
            setMentions(current => current.some(row => row.id === id) ? current.filter(row => row.id !== id) : current);
        }

        void refresh();
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessage);
        FluxDispatcher.subscribe("MESSAGE_DELETE", onDelete);
        return () => {
            active = false;
            clearTimeout(timer);
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
            FluxDispatcher.unsubscribe("MESSAGE_DELETE", onDelete);
        };
    }, [guildId, retry, scopeId, storageKey, userId]);

    const pending = mentions.filter(message => !visited.includes(message.id));
    const next = pending[0];
    const label = pending.length
        ? `Jump to newest mention (${pending.length} to review)`
        : status === "loading" ? "Loading mentions"
            : status === "error" ? "Retry loading mentions" : "No recent mentions to review";

    function jump() {
        if (!next) {
            if (status === "error") {
                setStatus("loading");
                setRetry(value => value + 1);
            }
            return;
        }

        try {
            if (SelectedChannelStore.getChannelId() === next.channel_id) {
                MessageActions.jumpToMessage({
                    channelId: next.channel_id, messageId: next.id, flash: true, jumpType: "INSTANT"
                });
            } else {
                NavigationRouter.transitionTo(`/channels/${guildId ?? "@me"}/${next.channel_id}/${next.id}`);
            }
        } catch {
            showToast({ text: "Could not open the mention", variant: "critical" });
            return;
        }

        setVisited(current => [...current, next.id]);
        void update<string[]>(storageKey, current => [next.id, ...(current ?? []).filter(id => id !== next.id)].slice(0, 500))
            .catch(() => {});
    }

    return (
        <ToolbarIcon
            tooltip={label}
            onClick={jump}
            icon={({ className }: { className?: string; }) => (
                <span aria-hidden="true" style={{ display: "inline-flex", position: "relative" }}>
                    <svg className={className} width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                        <circle cx={12} cy={12} r={4} />
                        <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
                    </svg>
                    {pending.length > 0 && (
                        <span style={{
                            position: "absolute", top: -4, right: -5, minWidth: 14, height: 14, padding: "0 2px",
                            boxSizing: "border-box", borderRadius: 8, background: "#fff", color: "#141414",
                            fontSize: 10, fontWeight: 700, lineHeight: "14px", textAlign: "center", pointerEvents: "none"
                        }}>
                            {pending.length}
                        </span>
                    )}
                </span>
            )}
        />
    );
}

export default definePlugin({
    name: "MentionJump",
    description: "Adds a chat toolbar badge that jumps to recent mentions in the current server or group DM.",
    authors: [{ name: "Local plugin", id: 0n }],

    patches: [{
        find: "Missing channel in Channel.renderHeaderToolbar",
        replacement: {
            match: /(?<=renderHeaderToolbar"\);let (\i)=\[\];)/,
            replace: '$1.push($self.renderMentionButton(this.props));'
        }
    }],

    renderMentionButton: ErrorBoundary.wrap(({ channel }: { channel: Channel; }) => {
        const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
        const guildId = channel.getGuildId() || undefined;
        if (!userId || (!guildId && !channel.isGroupDM())) return null;

        const scopeId = guildId ?? channel.id;
        return <MentionButton key={`${userId}:${scopeId}`} scopeId={scopeId} guildId={guildId} userId={userId} />;
    }, { noop: true })
});
