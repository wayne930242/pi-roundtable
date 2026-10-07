-- The database of a single-owner Discord host of pi-roundtable 0.8.0, written by scripts/fixture-db.ts.
CREATE TABLE public.agent_group_cursors (
    group_name text NOT NULL,
    agent_name text NOT NULL,
    last_id bigint NOT NULL,
    guild_id text NOT NULL
);

CREATE TABLE public.agent_group_messages (
    id bigint NOT NULL,
    group_name text NOT NULL,
    author text NOT NULL,
    author_name text NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    guild_id text NOT NULL
);

CREATE SEQUENCE public.agent_group_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.agent_group_messages_id_seq OWNED BY public.agent_group_messages.id;

CREATE TABLE public.agent_groups (
    name text NOT NULL,
    display_name text NOT NULL,
    channel_id text NOT NULL,
    members text NOT NULL,
    host text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    guild_id text NOT NULL
);

CREATE TABLE public.agent_skills (
    agent text NOT NULL,
    skill text NOT NULL,
    guild_id text NOT NULL
);

CREATE TABLE public.agents (
    name text NOT NULL,
    display_name text NOT NULL,
    prompt text NOT NULL,
    avatar_prompt text NOT NULL,
    avatar_hash text,
    channel_id text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model text,
    thinking text,
    guild_id text NOT NULL
);

CREATE TABLE public.conversations (
    key text NOT NULL,
    surface text NOT NULL,
    kind text NOT NULL,
    principal_id text,
    visibility text NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversations_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'shared'::text])))
);

CREATE TABLE public.held_actions (
    channel_key text NOT NULL,
    selection_id text NOT NULL,
    held_at timestamp with time zone NOT NULL,
    calls text NOT NULL,
    speaker_id text,
    speaker_held_at timestamp with time zone
);

CREATE TABLE public.owner_memory (
    id bigint NOT NULL,
    fact text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'core'::text NOT NULL,
    event_date date,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    speaker_id text NOT NULL,
    CONSTRAINT owner_memory_fact_check CHECK ((length(btrim(fact)) > 0)),
    CONSTRAINT owner_memory_kind_check CHECK ((kind = ANY (ARRAY['core'::text, 'note'::text, 'event'::text])))
);

CREATE SEQUENCE public.owner_memory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.owner_memory_id_seq OWNED BY public.owner_memory.id;

CREATE TABLE public.roundtable_migrations (
    id text NOT NULL,
    plugin text NOT NULL,
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.schedules (
    id bigint NOT NULL,
    channel_key text NOT NULL,
    mode text NOT NULL,
    title text NOT NULL,
    prompt text NOT NULL,
    recurrence text NOT NULL,
    next_run timestamp with time zone NOT NULL,
    created_by_id text NOT NULL,
    created_by_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_run timestamp with time zone,
    last_status text,
    created_tier text DEFAULT 'owner'::text NOT NULL,
    precheck text,
    precheck_script text,
    precheck_tools text
);

CREATE SEQUENCE public.schedules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.schedules_id_seq OWNED BY public.schedules.id;

CREATE TABLE public.skill_groups (
    name text NOT NULL,
    description text NOT NULL,
    skills text NOT NULL
);

CREATE TABLE public.skills (
    name text NOT NULL,
    kind text NOT NULL,
    repo text,
    path text,
    description text,
    body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.agent_group_messages ALTER COLUMN id SET DEFAULT nextval('public.agent_group_messages_id_seq'::regclass);

ALTER TABLE ONLY public.owner_memory ALTER COLUMN id SET DEFAULT nextval('public.owner_memory_id_seq'::regclass);

ALTER TABLE ONLY public.schedules ALTER COLUMN id SET DEFAULT nextval('public.schedules_id_seq'::regclass);

INSERT INTO public.conversations (key, surface, kind, principal_id, visibility, title, created_at, last_active_at) VALUES ('web:c-1', 'web', 'chat', 'oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7', 'private', 'Trip plans', '2026-09-01 09:00:00+00', '2026-09-02 09:00:00+00');
INSERT INTO public.conversations (key, surface, kind, principal_id, visibility, title, created_at, last_active_at) VALUES ('web:c-2', 'web', 'chat', NULL, 'shared', NULL, '2026-09-01 09:00:00+00', '2026-09-02 09:00:00+00');

INSERT INTO public.held_actions (channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at) VALUES ('discord:966666600000000012', 'agent', '2026-09-01 09:00:00+00', '[{"tool":"bash","input":"{\"command\":\"rm -rf build\"}","action":"Remove build"}]', '966666600000000003', '2026-09-01 09:00:00+00');
INSERT INTO public.held_actions (channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at) VALUES ('discord:966666600000000013', 'agent', '2026-09-01 09:00:00+00', '[{"tool":"bash","input":"{\"command\":\"rm -rf build\"}","action":"Remove build"}]', NULL, NULL);

INSERT INTO public.owner_memory (id, fact, created_at, kind, event_date, updated_at, speaker_id) VALUES (1, 'Ada drinks oolong tea', '2026-09-01 09:00:00+00', 'core', NULL, '2026-09-01 09:00:00+00', '966666600000000001');
INSERT INTO public.owner_memory (id, fact, created_at, kind, event_date, updated_at, speaker_id) VALUES (2, 'Ada moved the standup to Tuesdays', '2026-09-01 09:00:00+00', 'note', NULL, '2026-09-01 09:00:00+00', '966666600000000001');
INSERT INTO public.owner_memory (id, fact, created_at, kind, event_date, updated_at, speaker_id) VALUES (3, 'Kai studies for the finals', '2026-09-01 09:00:00+00', 'core', NULL, '2026-09-01 09:00:00+00', '966666600000000003');
INSERT INTO public.owner_memory (id, fact, created_at, kind, event_date, updated_at, speaker_id) VALUES (4, 'Noa plans a trip', '2026-09-01 09:00:00+00', 'core', NULL, '2026-09-01 09:00:00+00', '966666600000000005');

INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('memory/owner-memory', 'memory', 'owner-memory', '2026-10-07 10:43:34.717264+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('memory/owner-memory-speaker', 'memory', 'owner-memory-speaker', '2026-10-07 10:43:34.720426+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('schedule-store/schedules', 'schedule-store', 'schedules', '2026-10-07 10:43:34.722932+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('schedule-store/schedules-precheck', 'schedule-store', 'schedules-precheck', '2026-10-07 10:43:34.725284+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('schedule-store/schedules-precheck-script', 'schedule-store', 'schedules-precheck-script', '2026-10-07 10:43:34.726157+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('schedule-store/schedules-precheck-tools', 'schedule-store', 'schedules-precheck-tools', '2026-10-07 10:43:34.726892+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('skills/skills', 'skills', 'skills', '2026-10-07 10:43:34.727425+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('skills/skills-guild', 'skills', 'skills-guild', '2026-10-07 10:43:34.72953+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('conversations/conversations', 'conversations', 'conversations', '2026-10-07 10:43:34.733044+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('runtime/held-actions', 'runtime', 'held-actions', '2026-10-07 10:43:34.734598+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('runtime/held-actions-speaker', 'runtime', 'held-actions-speaker', '2026-10-07 10:43:34.735706+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('runtime/held-actions-speaker-hold', 'runtime', 'held-actions-speaker-hold', '2026-10-07 10:43:34.736158+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('agent-server/agents', 'agent-server', 'agents', '2026-10-07 10:43:34.736654+00');
INSERT INTO public.roundtable_migrations (id, plugin, name, applied_at) VALUES ('agent-server/agents-guild', 'agent-server', 'agents-guild', '2026-10-07 10:43:34.740617+00');

INSERT INTO public.schedules (id, channel_key, mode, title, prompt, recurrence, next_run, created_by_id, created_by_name, created_at, last_run, last_status, created_tier, precheck, precheck_script, precheck_tools) VALUES (1, 'discord:966666600000000011', 'owner', 'Ada''s daily check', 'Check the news.', '{"kind":"every","time":"09:00","everyDays":1,"startDate":"2026-09-01"}', '2026-10-08 09:00:00+00', '966666600000000001', 'Ada', '2026-09-01 09:00:00+00', NULL, NULL, 'owner', NULL, NULL, NULL);
INSERT INTO public.schedules (id, channel_key, mode, title, prompt, recurrence, next_run, created_by_id, created_by_name, created_at, last_run, last_status, created_tier, precheck, precheck_script, precheck_tools) VALUES (2, 'discord:966666600000000012', 'owner', 'Kai''s daily check', 'Check the news.', '{"kind":"every","time":"09:00","everyDays":1,"startDate":"2026-09-01"}', '2026-10-08 09:00:00+00', '966666600000000003', 'Kai', '2026-09-01 09:00:00+00', NULL, NULL, 'member', NULL, NULL, NULL);
INSERT INTO public.schedules (id, channel_key, mode, title, prompt, recurrence, next_run, created_by_id, created_by_name, created_at, last_run, last_status, created_tier, precheck, precheck_script, precheck_tools) VALUES (3, 'mcp:remote', 'owner', 'Remote''s daily check', 'Check the news.', '{"kind":"every","time":"09:00","everyDays":1,"startDate":"2026-09-01"}', '2026-10-08 09:00:00+00', 'remote-mcp', 'Remote', '2026-09-01 09:00:00+00', NULL, NULL, 'owner', NULL, NULL, NULL);

SELECT pg_catalog.setval('public.agent_group_messages_id_seq', 1, false);

SELECT pg_catalog.setval('public.owner_memory_id_seq', 4, true);

SELECT pg_catalog.setval('public.schedules_id_seq', 3, true);

ALTER TABLE ONLY public.agent_group_cursors
    ADD CONSTRAINT agent_group_cursors_pkey PRIMARY KEY (guild_id, group_name, agent_name);

ALTER TABLE ONLY public.agent_group_messages
    ADD CONSTRAINT agent_group_messages_pkey PRIMARY KEY (guild_id, id);

ALTER TABLE ONLY public.agent_groups
    ADD CONSTRAINT agent_groups_channel_id_key UNIQUE (channel_id);

ALTER TABLE ONLY public.agent_groups
    ADD CONSTRAINT agent_groups_pkey PRIMARY KEY (guild_id, name);

ALTER TABLE ONLY public.agent_skills
    ADD CONSTRAINT agent_skills_pkey PRIMARY KEY (guild_id, agent, skill);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_channel_id_key UNIQUE (channel_id);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (guild_id, name);

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.held_actions
    ADD CONSTRAINT held_actions_pkey PRIMARY KEY (channel_key);

ALTER TABLE ONLY public.owner_memory
    ADD CONSTRAINT owner_memory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.roundtable_migrations
    ADD CONSTRAINT roundtable_migrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_groups
    ADD CONSTRAINT skill_groups_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (name);

CREATE INDEX agent_group_messages_group ON public.agent_group_messages USING btree (group_name, id);

CREATE INDEX conversations_principal ON public.conversations USING btree (principal_id, last_active_at DESC);

CREATE INDEX owner_memory_speaker ON public.owner_memory USING btree (speaker_id, id);

CREATE INDEX schedules_channel ON public.schedules USING btree (channel_key);

CREATE INDEX schedules_next_run ON public.schedules USING btree (next_run);
