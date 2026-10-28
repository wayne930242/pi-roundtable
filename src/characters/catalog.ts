import type {
	CharacterColors,
	CharacterSpec,
	Hex,
	PaletteName,
} from "./spec.ts";

/** Freeze a value and everything reachable from it, so a shared catalog cannot be edited. */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

export const CLASS_IDS = [
	"wizard",
	"knight",
	"scholar",
	"smith",
	"ranger",
	"bard",
	"alchemist",
	"healer",
	"steward",
	"navigator",
	"seer",
	"scribe",
	"engineer",
	"druid",
	"innkeeper",
	"sentinel",
	"envoy",
	"rogue",
	"monk",
	"falconer",
	"shipwright",
	"jester",
	"paladin",
	"archivist",
] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export type OutfitId =
	| "robe"
	| "scholar"
	| "armor"
	| "plate"
	| "apron"
	| "chef"
	| "cloak"
	| "tunic"
	| "coat"
	| "overalls"
	| "vest"
	| "habit"
	| "surplice"
	| "motley"
	| "sailor";
export const OUTFIT_IDS: readonly OutfitId[] = [
	"robe",
	"scholar",
	"armor",
	"plate",
	"apron",
	"chef",
	"cloak",
	"tunic",
	"coat",
	"overalls",
	"vest",
	"habit",
	"surplice",
	"motley",
	"sailor",
];

export type HatId =
	| "none"
	| "wizard"
	| "helm"
	| "mortar"
	| "goggcap"
	| "hood"
	| "beret"
	| "goggles"
	| "coif"
	| "tallcap"
	| "tricorn"
	| "turban"
	| "softcap"
	| "hardhat"
	| "wreath"
	| "toque"
	| "kettle"
	| "cavalier"
	| "cowl"
	| "headband"
	| "fcap"
	| "sailor"
	| "jester"
	| "winghelm";
export const HAT_IDS: readonly HatId[] = [
	"none",
	"wizard",
	"helm",
	"mortar",
	"goggcap",
	"hood",
	"beret",
	"goggles",
	"coif",
	"tallcap",
	"tricorn",
	"turban",
	"softcap",
	"hardhat",
	"wreath",
	"toque",
	"kettle",
	"cavalier",
	"cowl",
	"headband",
	"fcap",
	"sailor",
	"jester",
	"winghelm",
];

export type PropId =
	| "staff"
	| "shield"
	| "scroll"
	| "hammer"
	| "bow"
	| "lute"
	| "flask"
	| "quill"
	| "tome"
	| "bell"
	| "keys"
	| "map"
	| "telescope"
	| "wrench"
	| "spade"
	| "ladle"
	| "lantern"
	| "seal"
	| "dagger"
	| "beads"
	| "bird"
	| "anchor"
	| "marotte"
	| "sword";
export const PROP_IDS: readonly PropId[] = [
	"staff",
	"shield",
	"scroll",
	"hammer",
	"bow",
	"lute",
	"flask",
	"quill",
	"tome",
	"bell",
	"keys",
	"map",
	"telescope",
	"wrench",
	"spade",
	"ladle",
	"lantern",
	"seal",
	"dagger",
	"beads",
	"bird",
	"anchor",
	"marotte",
	"sword",
];

export type HairId =
	| "none"
	| "short"
	| "bob"
	| "long"
	| "bun"
	| "curly"
	| "ponytail"
	| "braid";
export const HAIR_IDS: readonly HairId[] = [
	"none",
	"short",
	"bob",
	"long",
	"bun",
	"curly",
	"ponytail",
	"braid",
];

export type BeardId = "full" | "mustache" | "goatee";
export const BEARD_IDS: readonly BeardId[] = ["full", "mustache", "goatee"];
export const BEARD_CHOICES: readonly (BeardId | "none")[] = [
	...BEARD_IDS,
	"none",
];

export type AccessoryId = "glasses" | "freckles" | "scar";
export const ACCESSORY_IDS: readonly AccessoryId[] = [
	"glasses",
	"freckles",
	"scar",
];
export const ACCESSORY_CHOICES: readonly (AccessoryId | "none")[] = [
	...ACCESSORY_IDS,
	"none",
];

export const BUILDS: readonly CharacterSpec["build"][] = [
	"slim",
	"regular",
	"stout",
];

export const SKIN_INDEXES: readonly CharacterSpec["skin"][] = [
	0, 1, 2, 3, 4, 5,
];

export const EXPRESSIONS = [
	"neutral",
	"happy",
	"thinking",
	"concerned",
	"apologetic",
	"surprised",
	"proud",
	"amused",
	"curious",
	"sympathetic",
	"playful",
	"determined",
	"sleepy",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const AVATAR_STATES = [
	"idle",
	"thinking",
	"working",
	"waiting",
	"done",
	"error",
	"sleepy",
] as const;
export type AvatarState = (typeof AVATAR_STATES)[number];

export const STATE_EXPRESSION: Readonly<Record<AvatarState, Expression>> =
	deepFreeze({
		idle: "neutral",
		thinking: "thinking",
		working: "determined",
		waiting: "curious",
		done: "proud",
		error: "apologetic",
		sleepy: "sleepy",
	});

/** Heraldic palettes: the field (also the agent accent), a secondary tincture and the metal trim. */
const PALETTES: Record<PaletteName, CharacterColors> = {
	azure: { primary: "#3b6fd8", secondary: "#eef2ff", trim: "#f0c04a" },
	gules: { primary: "#d8473d", secondary: "#fff1e4", trim: "#f0c04a" },
	vert: { primary: "#2f9e6b", secondary: "#eefbea", trim: "#f0c04a" },
	purpure: { primary: "#7d52cc", secondary: "#f1e9ff", trim: "#f0c04a" },
	amber: { primary: "#e2a02a", secondary: "#fff6dc", trim: "#d5dbe8" },
	sable: { primary: "#454a5c", secondary: "#e9ecf4", trim: "#f0c04a" },
	teal: { primary: "#1f9aa6", secondary: "#e6fbfa", trim: "#f0c04a" },
	rose: { primary: "#d6507f", secondary: "#ffeef3", trim: "#d5dbe8" },
};

/** Skin tones, light to dark. */
const SKINS: readonly Hex[] = [
	"#f7d6b8",
	"#eab98c",
	"#d4a070",
	"#b9784c",
	"#8e5b3c",
	"#5c3a26",
];

/** Hair swatches; a spec may carry any other hex. */
const HAIR_COLORS: readonly Hex[] = [
	"#2b2233",
	"#6a4a33",
	"#b0562f",
	"#e0b45a",
	"#aeb4c3",
	"#f1f3fa",
];

type ClassPreset = Omit<CharacterSpec, "v" | "class">;

function preset(
	fields: Omit<ClassPreset, "colors" | "palette"> & { palette: PaletteName },
): ClassPreset {
	const { palette, ...rest } = fields;
	return { ...rest, colors: { ...PALETTES[palette] }, palette };
}

interface ClassEntry {
	label: string;
	/** The agent jobs the class suits. */
	jobs: string;
	/** English and zh-TW words that suggest the class from an agent's name and prompt. */
	keywords: readonly string[];
	preset: ClassPreset;
}

const CLASSES: Record<ClassId, ClassEntry> = {
	wizard: {
		label: "Wizard",
		jobs: "coordinator, planner, main assistant",
		keywords: [
			"coordinat",
			"orchestrat",
			"lead",
			"chief",
			"manager",
			"協調",
			"統籌",
			"總管",
			"主管",
		],
		preset: preset({
			outfit: "robe",
			hat: "wizard",
			prop: "staff",
			hair: "none",
			beard: "full",
			accessory: "none",
			build: "regular",
			skin: 0,
			hairColor: "#f1f3fa",
			palette: "azure",
		}),
	},
	knight: {
		label: "Knight",
		jobs: "reviewer, QA gate, guardian",
		keywords: [
			"review",
			"qa",
			"quality",
			"gate",
			"lint",
			"guardian",
			"審查",
			"審核",
			"把關",
			"品質",
		],
		preset: preset({
			outfit: "armor",
			hat: "helm",
			prop: "shield",
			hair: "short",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 1,
			hairColor: "#6a4a33",
			palette: "gules",
		}),
	},
	scholar: {
		label: "Scholar",
		jobs: "researcher, literature review",
		keywords: [
			"research",
			"literature",
			"paper",
			"study",
			"survey",
			"academic",
			"研究",
			"文獻",
			"論文",
			"學者",
		],
		preset: preset({
			outfit: "scholar",
			hat: "mortar",
			prop: "scroll",
			hair: "bun",
			beard: "none",
			accessory: "glasses",
			build: "slim",
			skin: 2,
			hairColor: "#2b2233",
			palette: "purpure",
		}),
	},
	smith: {
		label: "Smith",
		jobs: "coder, builder, refactorer",
		keywords: [
			"coder",
			"coding",
			"code",
			"builder",
			"implement",
			"develop",
			"refactor",
			"software",
			"程式",
			"開發",
			"實作",
			"重構",
		],
		preset: preset({
			outfit: "apron",
			hat: "goggcap",
			prop: "hammer",
			hair: "short",
			beard: "none",
			accessory: "none",
			build: "stout",
			skin: 3,
			hairColor: "#7a4a2a",
			palette: "amber",
		}),
	},
	ranger: {
		label: "Ranger",
		jobs: "scout, web search, crawler",
		keywords: [
			"scout",
			"search",
			"crawl",
			"explore",
			"browse",
			"web",
			"搜尋",
			"爬蟲",
			"偵查",
			"探索",
		],
		preset: preset({
			outfit: "cloak",
			hat: "hood",
			prop: "bow",
			hair: "none",
			beard: "none",
			accessory: "freckles",
			build: "slim",
			skin: 1,
			hairColor: "#a8683a",
			palette: "vert",
		}),
	},
	bard: {
		label: "Bard",
		jobs: "writer, announcer, copywriter",
		keywords: [
			"writer",
			"write",
			"copywrit",
			"announce",
			"content",
			"blog",
			"story",
			"poet",
			"寫作",
			"文案",
			"文章",
			"公告",
		],
		preset: preset({
			outfit: "tunic",
			hat: "beret",
			prop: "lute",
			hair: "long",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 4,
			hairColor: "#c0453d",
			palette: "rose",
		}),
	},
	alchemist: {
		label: "Alchemist",
		jobs: "data analyst, ETL, transformer",
		keywords: [
			"analyst",
			"data",
			"etl",
			"transform",
			"convert",
			"spreadsheet",
			"資料",
			"數據",
			"轉換",
			"分析師",
		],
		preset: preset({
			outfit: "coat",
			hat: "goggles",
			prop: "flask",
			hair: "curly",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 5,
			hairColor: "#2b2233",
			palette: "teal",
		}),
	},
	healer: {
		label: "Healer",
		jobs: "debugger, fixer, support",
		keywords: [
			"debug",
			"fix",
			"doctor",
			"heal",
			"bug",
			"repair",
			"triage",
			"support",
			"醫",
			"修",
			"除錯",
			"診斷",
		],
		preset: preset({
			outfit: "surplice",
			hat: "coif",
			prop: "bell",
			hair: "none",
			beard: "none",
			accessory: "none",
			build: "stout",
			skin: 5,
			hairColor: "#2b2233",
			palette: "rose",
		}),
	},
	steward: {
		label: "Steward",
		jobs: "ops, billing, access keys",
		keywords: [
			"ops",
			"billing",
			"admin",
			"account",
			"access",
			"finance",
			"invoice",
			"procure",
			"帳務",
			"財務",
			"營運",
			"請款",
			"管理",
		],
		preset: preset({
			outfit: "vest",
			hat: "tallcap",
			prop: "keys",
			hair: "short",
			beard: "mustache",
			accessory: "none",
			build: "stout",
			skin: 0,
			hairColor: "#8a8f9c",
			palette: "sable",
		}),
	},
	navigator: {
		label: "Navigator",
		jobs: "planner, routing, roadmap",
		keywords: [
			"planner",
			"planning",
			"roadmap",
			"route",
			"routing",
			"navigat",
			"itinerary",
			"規劃",
			"路線",
			"導航",
			"行程",
		],
		preset: preset({
			outfit: "coat",
			hat: "tricorn",
			prop: "map",
			hair: "ponytail",
			beard: "none",
			accessory: "none",
			build: "slim",
			skin: 2,
			hairColor: "#6a4a33",
			palette: "azure",
		}),
	},
	seer: {
		label: "Seer",
		jobs: "forecaster, monitoring, analytics",
		keywords: [
			"forecast",
			"monitor",
			"predict",
			"analytics",
			"metric",
			"observab",
			"trend",
			"預測",
			"監控",
			"觀測",
			"趨勢",
		],
		preset: preset({
			outfit: "habit",
			hat: "turban",
			prop: "telescope",
			hair: "none",
			beard: "none",
			accessory: "none",
			build: "slim",
			skin: 3,
			hairColor: "#2b2233",
			palette: "purpure",
		}),
	},
	scribe: {
		label: "Scribe",
		jobs: "documentation, notes, minutes",
		keywords: [
			"document",
			"docs",
			"notes",
			"minutes",
			"transcri",
			"changelog",
			"文件",
			"記錄",
			"紀錄",
			"筆記",
			"會議",
		],
		preset: preset({
			outfit: "scholar",
			hat: "softcap",
			prop: "quill",
			hair: "short",
			beard: "none",
			accessory: "glasses",
			build: "regular",
			skin: 1,
			hairColor: "#3a2f45",
			palette: "sable",
		}),
	},
	engineer: {
		label: "Engineer",
		jobs: "devops, infra, CI",
		keywords: [
			"infra",
			"devops",
			"ci",
			"sre",
			"platform",
			"kubernetes",
			"server",
			"cluster",
			"維運",
			"運維",
			"基礎設施",
			"伺服器",
		],
		preset: preset({
			outfit: "overalls",
			hat: "hardhat",
			prop: "wrench",
			hair: "braid",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 4,
			hairColor: "#2b2233",
			palette: "amber",
		}),
	},
	druid: {
		label: "Druid",
		jobs: "cleanup, data hygiene, maintenance",
		keywords: [
			"cleanup",
			"clean",
			"hygiene",
			"maintenance",
			"garbage",
			"prune",
			"tidy",
			"清理",
			"整理",
			"維護",
			"保養",
		],
		preset: preset({
			outfit: "cloak",
			hat: "wreath",
			prop: "spade",
			hair: "long",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 4,
			hairColor: "#6a4a33",
			palette: "vert",
		}),
	},
	innkeeper: {
		label: "Innkeeper",
		jobs: "concierge, onboarding, scheduler",
		keywords: [
			"concierge",
			"onboard",
			"scheduler",
			"schedule",
			"host",
			"welcome",
			"reception",
			"接待",
			"迎賓",
			"排程",
			"新人",
		],
		preset: preset({
			outfit: "chef",
			hat: "toque",
			prop: "ladle",
			hair: "none",
			beard: "mustache",
			accessory: "none",
			build: "stout",
			skin: 2,
			hairColor: "#2b2233",
			palette: "gules",
		}),
	},
	sentinel: {
		label: "Sentinel",
		jobs: "security, on-call, alerts",
		keywords: [
			"security",
			"alert",
			"incident",
			"oncall",
			"on-call",
			"vulnerab",
			"patrol",
			"資安",
			"安全",
			"告警",
			"警報",
			"值班",
		],
		preset: preset({
			outfit: "plate",
			hat: "kettle",
			prop: "lantern",
			hair: "none",
			beard: "none",
			accessory: "scar",
			build: "stout",
			skin: 5,
			hairColor: "#2b2233",
			palette: "sable",
		}),
	},
	envoy: {
		label: "Envoy",
		jobs: "email, partner comms, notifications",
		keywords: [
			"email",
			"mail",
			"partner",
			"notif",
			"message",
			"outreach",
			"comms",
			"信件",
			"郵件",
			"通知",
			"聯絡",
		],
		preset: preset({
			outfit: "tunic",
			hat: "cavalier",
			prop: "seal",
			hair: "bun",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 1,
			hairColor: "#aeb4c3",
			palette: "purpure",
		}),
	},
	rogue: {
		label: "Rogue",
		jobs: "pen-tester, auditor, intel",
		keywords: [
			"pentest",
			"pen-test",
			"penetration",
			"auditor",
			"audit",
			"intel",
			"exploit",
			"osint",
			"滲透",
			"稽核",
			"情報",
			"紅隊",
		],
		preset: preset({
			outfit: "cloak",
			hat: "cowl",
			prop: "dagger",
			hair: "none",
			beard: "none",
			accessory: "scar",
			build: "slim",
			skin: 0,
			hairColor: "#2b2233",
			palette: "sable",
		}),
	},
	monk: {
		label: "Monk",
		jobs: "long-running jobs, batch, patience",
		keywords: [
			"long-running",
			"batch",
			"patient",
			"background",
			"overnight",
			"meditat",
			"cron",
			"長時間",
			"批次",
			"批量",
			"耐心",
		],
		preset: preset({
			outfit: "habit",
			hat: "headband",
			prop: "beads",
			hair: "none",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 3,
			hairColor: "#2b2233",
			palette: "amber",
		}),
	},
	falconer: {
		label: "Falconer",
		jobs: "retrieval, fetch, RAG lookup",
		keywords: [
			"retriev",
			"fetch",
			"rag",
			"lookup",
			"vector",
			"embedding",
			"檢索",
			"擷取",
			"抓取",
			"查詢",
		],
		preset: preset({
			outfit: "cloak",
			hat: "fcap",
			prop: "bird",
			hair: "short",
			beard: "goatee",
			accessory: "none",
			build: "slim",
			skin: 4,
			hairColor: "#2b2233",
			palette: "vert",
		}),
	},
	shipwright: {
		label: "Shipwright",
		jobs: "release, build pipeline, packaging",
		keywords: [
			"release",
			"ship",
			"packag",
			"publish",
			"deploy",
			"pipeline",
			"發版",
			"發布",
			"打包",
			"上線",
			"部署",
		],
		preset: preset({
			outfit: "sailor",
			hat: "sailor",
			prop: "anchor",
			hair: "short",
			beard: "goatee",
			accessory: "none",
			build: "stout",
			skin: 2,
			hairColor: "#e0b45a",
			palette: "azure",
		}),
	},
	jester: {
		label: "Jester",
		jobs: "brainstorm, ideation, humor",
		keywords: [
			"brainstorm",
			"ideation",
			"idea",
			"humor",
			"joke",
			"creative",
			"fun",
			"腦力激盪",
			"發想",
			"創意",
			"幽默",
			"點子",
		],
		preset: preset({
			outfit: "motley",
			hat: "jester",
			prop: "marotte",
			hair: "none",
			beard: "none",
			accessory: "freckles",
			build: "slim",
			skin: 0,
			hairColor: "#b0562f",
			palette: "gules",
		}),
	},
	paladin: {
		label: "Paladin",
		jobs: "compliance, policy, approvals",
		keywords: [
			"compliance",
			"policy",
			"approval",
			"approve",
			"govern",
			"legal",
			"ethic",
			"合規",
			"法遵",
			"核准",
			"政策",
			"規範",
		],
		preset: preset({
			outfit: "plate",
			hat: "winghelm",
			prop: "sword",
			hair: "none",
			beard: "none",
			accessory: "none",
			build: "regular",
			skin: 5,
			hairColor: "#2b2233",
			palette: "amber",
		}),
	},
	archivist: {
		label: "Archivist",
		jobs: "knowledge base, indexing, memory",
		keywords: [
			"knowledge",
			"archive",
			"index",
			"memory",
			"wiki",
			"catalog",
			"library",
			"知識",
			"索引",
			"記憶",
			"歸檔",
			"典藏",
		],
		preset: preset({
			outfit: "scholar",
			hat: "none",
			prop: "tome",
			hair: "bun",
			beard: "none",
			accessory: "glasses",
			build: "regular",
			skin: 2,
			hairColor: "#e4e7f0",
			palette: "teal",
		}),
	},
};

export const CATALOG: Readonly<{
	classes: Readonly<
		Record<
			ClassId,
			Readonly<{
				label: string;
				/** The agent jobs the class suits. */
				jobs: string;
				/** English and zh-TW words that suggest the class from an agent's name and prompt. */
				keywords: readonly string[];
				preset: Omit<CharacterSpec, "v" | "class">;
			}>
		>
	>;
	outfits: readonly OutfitId[];
	hats: readonly HatId[];
	props: readonly PropId[];
	hair: readonly HairId[];
	beards: readonly BeardId[];
	accessories: readonly AccessoryId[];
	palettes: Readonly<Record<PaletteName, CharacterColors>>;
	skins: readonly Hex[];
	hairColors: readonly Hex[];
}> = deepFreeze({
	classes: CLASSES,
	outfits: OUTFIT_IDS,
	hats: HAT_IDS,
	props: PROP_IDS,
	hair: HAIR_IDS,
	beards: BEARD_IDS,
	accessories: ACCESSORY_IDS,
	palettes: PALETTES,
	skins: SKINS,
	hairColors: HAIR_COLORS,
});

export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
