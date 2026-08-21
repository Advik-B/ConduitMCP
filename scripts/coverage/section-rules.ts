// How a tutorial section heading is tiered.
//
// The sweep is exhaustive at heading level, so every heading on every in-scope
// page lands in exactly one of three buckets: excluded (the area is not
// automatable through an engine API at all), concept (the heading explains
// something rather than telling the reader to do something), or an action with a
// tier. Rules are ordered and the first match wins; anything that matches
// nothing is reported as "unclassified" rather than quietly assumed covered,
// which is what keeps the sweep honest as the docs change.
//
// Precedence is the whole design here. Specific rules must precede the generic
// "this is a node property" catch-alls, or a heading like "Using the Import
// dock" is claimed as covered by gd_scene_node_set_property on the strength of
// the words "using the".

export type Tier = "T0" | "T1" | "T2" | "T3" | "T4" | "T5";

export interface SectionRule {
  id: string;
  kind: "action" | "concept";
  tier: Tier;
  /** Which tool reaches it, or why nothing does. */
  via: string;
  /** Restrict the rule to pages whose id starts with one of these. */
  pages?: string[];
  /** Case-insensitive substrings matched against page id and heading. */
  match?: string[];
}

/**
 * Areas excluded from the denominator, each with the reason stated. These
 * describe work that happens outside a running engine process, so no in-process
 * bridge could reach them regardless of design.
 */
export const EXCLUDED_AREAS: Record<string, string> = {
  "tutorials/math": "Mathematical background, not engine actions.",
  "tutorials/best_practices": "Design guidance, no discrete engine action.",
  "tutorials/migrating": "Release-to-release upgrade notes about API changes.",
  "tutorials/troubleshooting": "Host and driver problems outside the engine API.",
  "tutorials/performance": "Profiling and optimisation advice, not discrete actions.",
  "tutorials/platform": "Platform SDK integration (Android/iOS/Web plugins) built outside the editor.",
  "tutorials/index": "Table of contents.",
  "getting_started/introduction": "Conceptual orientation to the engine.",
};

/** Headings that explain rather than instruct, matched on the heading alone. */
const CONCEPT_TITLES = [
  "introduction",
  "intro",
  "overview",
  "summary",
  "conclusion",
  "prerequisites",
  "contents",
  "further reading",
  "going further",
  "exploring the manual",
  "advantages",
  "disadvantages",
  "limitations",
  "reference",
  "background",
  "terminology",
  "glossary",
  "comparison",
  "next steps",
  "see also",
  "notes",
  "caveats",
  "troubleshooting",
  "common problems",
  "tips",
  "principles",
  "how it works",
  "how does it",
  "what is",
  "what can",
  "what this",
  "why ",
  "should i",
  "which ",
  "differences",
  "difference between",
  "example",
  "examples",
  "supported",
  "list of",
  "available",
  "requirements",
  "features",
  "use cases",
  "about",
  "structure of",
  "problems of",
  "precision errors",
  "who are",
  "so many controls",
  "the nature of",
  "jitter",
  "stutter",
  "input lag",
  "specification",
  "quick start guide",
  "getting started",
  "step 1",
  "step 2",
  "step 3",
  "code checkpoint",
  "your first",
  "complete script",
  "checking the results",
  "trying the plugin",
  "try the plugin",
  "putting it together",
  "putting it all together",
  "more information",
  "reporting ",
];

const CONCEPT_RULES: SectionRule[] = CONCEPT_TITLES.map((needle) => ({
  id: `concept:${needle.trim()}`,
  kind: "concept",
  tier: "T0",
  via: "explanatory prose, not an action",
  match: [needle],
}));

/** Work the docs describe doing in another program entirely. */
const EXTERNAL_RULES: SectionRule[] = [
  {
    id: "external:dcc",
    kind: "concept",
    tier: "T0",
    via: "performed in Blender, Maya, or another modelling tool, outside the engine",
    match: ["blender", "maya", "3ds max", "escn", "model export considerations", "exporting textures separately", "unwrap from your 3d modeling software"],
  },
  {
    id: "external:csharp",
    kind: "concept",
    tier: "T0",
    via: "C#/.NET workflow driven by an external SDK and IDE",
    match: ["c_sharp", "c# ", "csharp", ".net", "nuget", "rider", "visual studio", "external editor", "emacs", "vscode"],
  },
  {
    id: "external:gdextension",
    kind: "concept",
    tier: "T0",
    via: "GDExtension authoring is a compile-time C++ workflow outside the editor",
    match: ["gdextension", "compiling", "scons", "custom module"],
  },
  {
    id: "external:vcs",
    kind: "concept",
    tier: "T0",
    via: "version control performed by git, outside the engine",
    match: ["version control", "git plugin", "exclude from vcs"],
  },
  {
    id: "external:video",
    kind: "concept",
    tier: "T0",
    via: "video transcoding performed by ffmpeg after the engine has written frames",
    match: ["ffmpeg", "converting ogv", "converting png", "resizing video", "reducing framerate", "output format", "post-processing steps"],
  },
  {
    id: "external:platform_sdk",
    kind: "concept",
    tier: "T0",
    via: "platform SDK setup (JDK, Android SDK, Xcode, signing) performed outside the engine",
    match: [
      "gradle",
      "openjdk",
      "android sdk",
      "xcode",
      "code signing",
      "notariz",
      "provisioning",
      "apple developer",
      "keystore",
      "ico file",
      "taskbar icon",
      "file icon",
      "launcher icon",
      "google play",
      "app store",
      "entitlement",
      "sdk location",
      "xcode-select",
    ],
  },
  {
    id: "external:distribution",
    kind: "concept",
    tier: "T0",
    via: "packaging and distribution performed by platform tooling outside the engine",
    match: ["installer", "portable application", "distribution size", "sharing the finished game", "downloading demos", "asset library"],
  },
];

/** A dedicated tool performs this action. */
const T0_RULES: SectionRule[] = [
  {
    id: "t0:play",
    kind: "action",
    tier: "T0",
    via: "gd_play / gd_stop",
    match: ["running the scene", "running the game", "run the project", "playing the scene", "testing the scene", "running the editor"],
  },
  {
    id: "t0:export",
    kind: "action",
    tier: "T0",
    via: "gd_export_presets / gd_export_project",
    pages: ["tutorials/export"],
    match: ["export", "preset", "pck", "packaging", "dedicated server"],
  },
  {
    id: "t0:debugger",
    kind: "action",
    tier: "T0",
    via: "gd_debug",
    match: ["breakpoint", "debugger", "step over", "stack trace", "debugging"],
  },
  {
    id: "t0:input_map",
    kind: "action",
    tier: "T0",
    via: "gd_input_map",
    match: ["input action", "inputmap", "input map", "keyboard shortcut", "capturing actions"],
  },
  {
    id: "t0:autoload",
    kind: "action",
    tier: "T0",
    via: "gd_autoload",
    match: ["autoload", "registering autoloads"],
  },
  // Phase 15. These precede the T2 page rules below, so the headings they name
  // are graded on the tool that reaches them while the rest of each page still
  // falls through to the catch-all that describes what is genuinely left.
  {
    // Only headings that name the act of toggling. "plugin.cfg" is a filename
    // rather than an action and appears throughout the authoring tutorials,
    // which this tool does not reach; claiming those would overstate coverage
    // in the one direction the T2 backstop below cannot correct.
    id: "t0:plugin_toggle",
    kind: "action",
    tier: "T0",
    via: "gd_editor_plugin",
    pages: ["tutorials/plugins"],
    match: ["enabling a plugin", "enable the plugin", "activating a plugin"],
  },
  {
    // Deliberately not "importing translations" or "testing translations":
    // both are already claimed by more specific rules above (the import
    // pipeline, and gd_window's locale accessors), and both were already T0.
    // Taking them would change the attribution without changing the grade.
    id: "t0:translation_registration",
    kind: "action",
    tier: "T0",
    via: "gd_translations",
    match: [
      "translation remap",
      "resource remap",
      "localizing resources",
      "csv file as a translation",
      "translating the project name",
      "adding a translation",
      "fallback locale",
    ],
  },
  {
    id: "t0:project_settings",
    kind: "action",
    tier: "T0",
    via: "gd_project_get_setting / gd_project_set_setting",
    match: [
      "project setting",
      "setting the main scene",
      "changed defaults",
      "project setup",
      "setting up the project",
      "creating a project",
      "setting the project path",
      "large world coordinates",
      "physics tick rate",
      "power saving prevention",
      "switching between renderers",
    ],
  },
  {
    id: "t0:tilemap_cells",
    kind: "action",
    tier: "T0",
    via: "gd_tilemap",
    match: ["using tilemaps", "gridmap", "placing tiles", "painting tiles"],
  },
  {
    id: "t0:audio_bus",
    kind: "action",
    tier: "T0",
    via: "gd_audio",
    match: ["audio bus", "bus layout", "bus rearrangement", "reverb bus", "playback of audio through a bus", "adding effects"],
  },
  {
    id: "t0:animation_play",
    kind: "action",
    tier: "T0",
    via: "gd_animation",
    match: ["animationplayer", "controlling the animation in code", "controlling from code", "playing an animation", "sprite animation", "animating the mobs", "character animation", "the float animation"],
  },
  {
    id: "t0:navigation",
    kind: "action",
    tier: "T0",
    via: "gd_physics (nav_bake, nav_path)",
    match: [
      "navigation mesh",
      "navigationregion",
      "navigationagent",
      "navigationpath",
      "navigationmap",
      "navigation map",
      "pathfinding",
      "pathfollowing",
      "path simplification",
      "agent avoidance",
    ],
  },
  {
    id: "t0:physics_query",
    kind: "action",
    tier: "T0",
    via: "gd_physics (raycast, intersect_*)",
    match: ["raycast", "ray-casting", "ray casting", "intersect", "space state", "detecting collisions", "move_and_collide"],
  },
  {
    id: "t0:networking",
    kind: "action",
    tier: "T0",
    via: "gd_http_request / gd_websocket / gd_multiplayer",
    pages: ["tutorials/networking"],
    match: ["http", "websocket", "multiplayer", "rpc", "server", "client", "connection", "lobby", "authentication", "channel"],
  },
  {
    id: "t0:scene_edit",
    kind: "action",
    tier: "T0",
    via: "gd_scene_* / gd_node_*",
    match: [
      "creating your first scene",
      "creating the player scene",
      "node structure",
      "node setup",
      "scene instance",
      "creating instances",
      "instancing",
      "adding a camera",
      "scene inheritance",
      "changing a node's properties",
      "editing scenes and instances",
      "scene setup",
      "scene organization",
      "spawning mobs",
      "spawning monsters",
      "the main game scene",
      "adding our player body",
      "adding a floor",
    ],
  },
  {
    id: "t0:signals",
    kind: "action",
    tier: "T0",
    via: "gd_scene_signal / gd_signal",
    match: ["signal", "connecting hud"],
  },
  {
    id: "t0:script_edit",
    kind: "action",
    tier: "T0",
    via: "gd_script_create / gd_script_attach / gd_script_validate",
    match: [
      "creating a new script",
      "creating your first script",
      "the script file",
      "script template",
      "attach a script",
      "creating a c# script",
      "main script",
      "enemy script",
      "necessary code",
      "adding unit tests",
    ],
  },
  {
    id: "t0:window",
    kind: "action",
    tier: "T0",
    via: "gd_window",
    match: ["window size", "fullscreen", "window mode", "constraining the window size", "window focus", "spawning multiple windows", "hiding the window"],
  },
  {
    id: "t0:locale",
    kind: "action",
    tier: "T0",
    via: "gd_window (locale_get, locale_set)",
    match: ["automatically setting a language", "locale vs", "testing translations", "translationserver", "locale code"],
  },
  {
    id: "t0:asset_ingest",
    kind: "action",
    tier: "T0",
    via: "gd_asset_add / gd_asset_reimport",
    match: ["importing assets in godot", "reimporting multiple assets", "automatic reimport", "import process", "files generated", "ignoring specific folders"],
  },
  {
    id: "t0:file_ops",
    kind: "action",
    tier: "T0",
    via: "gd_file_move / gd_file_delete",
    match: ["erasing a scene", "organizing the project", "project organization"],
  },
  {
    id: "t0:pause",
    kind: "action",
    tier: "T0",
    via: "gd_pause / gd_step_frames / gd_set_time_scale",
    match: ["pause (f9)", "frame advance", "game speed", "quitting", "handling quit requests", "quit notification"],
  },
  {
    // Split out of the old t2:import_options on one line: a heading is T0 here
    // only when the action it names is a single [params] key/value in an
    // .import sidecar, which is exactly what gd_import_settings reads and
    // writes. Headings that need a sub-resource written or a plugin authored
    // stay behind in t2:import_authoring.
    id: "t0:import_options",
    kind: "action",
    tier: "T0",
    via: "gd_import_settings (get/set on the .import sidecar's [params])",
    match: [
      "import dock",
      "import option",
      "convert colors with editor theme",
      "import parameter",
      "advanced import settings",
      "import configuration",
      "import workflow",
      "changing import",
      "changing default import",
      "import hint",
      "import script",
      "importing 3d scenes",
      "importing images",
      "importing audio",
      "importing translations",
      "retargeting",
      "bone renamer",
      "rename bones",
      "unmapped bones",
      "unimportant positions",
      "bone transform",
      "normalize position tracks",
      "roughness limiter on import",
      "node type customization",
      "filter script",
      "optimizer",
      "assets pipeline",
      "on image import",
    ],
  },
];

/** Nothing in the surface reaches it. */
const T5_RULES: SectionRule[] = [
  {
    id: "t5:gizmo",
    kind: "action",
    tier: "T5",
    via: "no tool; 3D gizmo authoring is an editor-plugin surface with no runtime equivalent",
    match: ["gizmo"],
  },
  {
    id: "t5:xr_device",
    kind: "action",
    tier: "T5",
    via: "no tool; requires XR hardware and a runtime the bridge cannot simulate",
    pages: ["tutorials/xr"],
    match: [
      "openxr",
      "webxr",
      "openvr",
      "tiltfive",
      "headset",
      "passthrough",
      "hand tracking",
      "action map",
      "binding modifier",
      "haptic",
      "arcore",
      "room scale",
      "xr tools",
      "mobile vr",
      "vendors plugin",
      "deploying to android",
      "locomotion",
      "teleport",
      "direct movement",
      "projection matrix",
      "xr start script",
      "session begun",
      "visible state",
      "focused state",
      "stopping state",
      "pose recentered",
      "environment blend",
      "shadow to opacity",
    ],
  },
];

/** Only the editor's own control tree reaches it. */
const T3_RULES: SectionRule[] = [
  {
    id: "t3:editor_ui",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui (tier-2 control-tree driving); no semantic tool exists",
    match: [
      "dock",
      "editor layout",
      "editor settings",
      "customizing the interface",
      "customizing editor",
      "main screen",
      "bottom panel",
      "inspector",
      "movie maker",
      "creating movies",
      "game embedding",
      "profiler",
      "editor feature",
      "managing editor features",
      "recovery mode",
      "project manager",
      "script editor",
      "interaction mode",
      "select mode",
      "selection visibility",
      "camera override",
      "mute game audio",
      "previewing in the editor",
      "show the drawing while editing",
    ],
  },
];

/** No semantic tool; only arbitrary evaluation reaches it. */
const T2_RULES: SectionRule[] = [
  {
    // The residue of the old t2:import_options, after t0:import_options took
    // the headings that are a single [params] value. What is left needs
    // something gd_import_settings cannot do: author an EditorImportPlugin, or
    // drive the Advanced Import Settings dialog into writing a sub-resource
    // (an extracted material, a saved animation library, a sliced atlas) that
    // no single option name addresses.
    id: "t2:import_authoring",
    kind: "action",
    tier: "T2",
    via: "gd_import_settings reads and writes .import options, but these need an import plugin or a dialog-authored sub-resource; gd_editor_eval only",
    match: [
      "import plugin",
      "scene inheritance",
      "animation libraries",
      "slices",
      "extracting materials",
      "save to file",
    ],
  },
  {
    // Narrowed in phase 14, and corrected in phase 19. Phase 14 cut it down to
    // the compute pipeline and rested the T2 on the RID gap; phase 19 closed
    // that gap, and reading the one heading this rule still won shows it never
    // went through a RID at all. It sits under Introduction on the renderers
    // page and explains which renderer runs on which driver. The action beside
    // it, choosing a renderer, is a project setting and is already graded as
    // one by t0:project_settings on the next heading down.
    id: "concept:renderer_layers",
    kind: "concept",
    tier: "T0",
    via: "renderer and driver architecture prose, not an action",
    pages: ["tutorials/rendering/renderers"],
    match: ["renderers, rendering drivers"],
  },
  {
    // Narrowed in phase 15, in the sense that everything above it now catches
    // the toggle. What is left on this page is authoring: subclassing
    // EditorPlugin, EditorImportPlugin, EditorInspectorPlugin, and the gizmo
    // and dock surfaces. Those are ordinary GDScript in a project file, which
    // gd_script_create writes and t1:script_logic already grades, but the
    // editor-side registration each one performs has no semantic verb, so the
    // page keeps a T2 backstop rather than being declared reached.
    id: "t2:plugin_authoring",
    kind: "action",
    tier: "T2",
    via: "gd_editor_plugin enables and disables; authoring a plugin is gd_asset_add for plugin.cfg plus gd_script_create for the EditorPlugin script, and its editor-side registration has no dedicated verb",
    pages: ["tutorials/plugins"],
    match: [""],
  },
  {
    id: "t1:resource_method",
    kind: "action",
    tier: "T1",
    via: "gd_resource_call and gd_resource_get_property",
    match: [
      "meshlibrary",
      "mesh library",
      "material",
      "packedscene",
      "curve2d",
      "curve3d",
      "gradient",
      "animation library",
      "procedural geometry",
      "generating a rectangle",
      "surfacetool",
      "arraymesh",
      "custom meshes",
      "converting to meshinstance",
      "converting sprite2ds",
      "2d meshes",
      "multimesh",
      "csg",
      "cutout animation",
      "ik chain",
      "skeletal deform",
      "completing the skeleton",
      "creating the skeleton",
      "creating the polygons",
      "deforming the polygons",
      "internal vertices",
      "making of gbot",
      "font",
      "msdf",
      "mipmap",
      "emoji",
    ],
  },
  {
    id: "t1:singleton",
    kind: "action",
    tier: "T1",
    via: "gd_node_call / gd_scene_node_call with target: singleton:<Class>",
    match: [
      "renderingserver",
      "physicsserver",
      "navigationserver",
      "audioserver",
      "displayserver",
      "xrserver",
      "resourceloader",
      "resourcesaver",
      "input singleton",
      "javaclasswrapper",
      "javascriptbridge",
      "background loading",
      "runtime file loading",
      "saving and reading data",
      "file logging",
      "accessing files in the project",
      "plain text and binary files",
      "serialization",
      "json",
      "vibration",
      "motion sensor",
      "gyroscope",
      "accelerometer",
      "led color",
      "mouse cursor",
      "cursor list",
      "hardware display coordinates",
      "mouse and input coordinates",
    ],
  },
  {
    // Narrowed in phase 15. Registering a translation, remapping a resource,
    // and setting the fallback and test locale are gd_translations, and
    // t0:translation_registration above takes those needles. What is left here
    // is the gettext half: extraction into a POT template is EditorNode's own
    // POTGenerator, reachable only from the Localization dialog, and the
    // shaping and pluralisation headings are prose about the format rather
    // than actions a tool performs.
    id: "t2:gettext",
    kind: "action",
    tier: "T2",
    via: "gd_translations registers and remaps translations; extracting strings into a POT template is an editor menu action with no scripted entry point (docs/api-gaps.md)",
    match: [
      "gettext",
      "po file",
      "po template",
      "messages file",
      "extracting localizable",
      "translation context",
      "pluralization",
      "plural form",
      "bidirectional text",
      "bidi",
      "break iterator",
      "localizing",
      "placeholder",
      "converting keys to text",
    ],
  },
  {
    id: "t2:custom_draw",
    kind: "action",
    tier: "T2",
    via: "gd_render debug_draw covers line, circle, rect, sphere, and box only; arbitrary _draw() work needs a script",
    match: ["custom drawing", "drawing a custom polygon", "drawing connected lines", "drawing circles", "drawing lines", "drawing a straight line", "coordinates and line width"],
  },
];

/** Reachable generically through reflection, with no dedicated verb. */
const T1_RULES: SectionRule[] = [
  {
    // Corrected in phase 18, by reading all six heading bodies rather than by
    // matching method names. The rule used to grade them T5 on the strength of
    // AccessibilityServer being a singleton nothing could target, which stopped
    // being true in phase 10 -- but the pages do not go through
    // AccessibilityServer at all, and the mechanisms differ per heading:
    // text to speech is DisplayServer.tts_*, desktop notifications are
    // OS.execute (the page states Godot has no native API), the system tray is
    // a StatusIndicator node, the global menu is MenuBar.prefer_global_menu,
    // client-side decorations are the display/window/size/extend_to_title
    // project setting, and the screen reader is
    // accessibility/general/accessibility_support plus Control's
    // accessibility_name and accessibility_description.
    //
    // T1 is a floor, not a ceiling: the two project-setting headings are
    // arguably T0 through gd_project_set_setting. Understating there costs
    // nothing, because T0 and T1 are both "not a gap", and one rule carries one
    // tier. The singleton half needs no new acceptance -- `bun run phase10`
    // already drives singleton dispatch with --disable-eval.
    id: "t1:system_integration",
    kind: "action",
    tier: "T1",
    via: "reachable without eval, by three different mechanisms: singleton:DisplayServer for text to speech and singleton:OS execute for desktop notifications (accepted by bun run phase10), a StatusIndicator or MenuBar node for the tray and the global menu, and project settings for client-side decorations and screen reader support",
    match: ["screen reader", "accessibility", "text to speech", "desktop notification", "system tray", "global menu", "client-side decoration"],
  },
  {
    id: "t1:script_logic",
    kind: "action",
    tier: "T1",
    via: "gd_script_create plus gd_node_call; the action is ordinary script logic",
    match: [
      "in code",
      "from code",
      "with code",
      "coding",
      "gdscript",
      "_process",
      "_ready",
      "_init",
      "script",
      "moving the player",
      "movement",
      "jumping",
      "squashing",
      "killing the player",
      "removing monsters",
      "removing old creeps",
      "retrying",
      "score",
      "ending the game",
      "spawn",
      "simulate",
      "traversal",
      "evaluating",
      "manipulating transforms",
      "obtaining information",
      "interpolation",
    ],
  },
  {
    id: "t1:node_property",
    kind: "action",
    tier: "T1",
    via: "gd_scene_node_set_property / gd_node_set_property",
    match: [
      "property",
      "properties",
      "configure",
      "configuring",
      "setting up",
      "set up",
      "setup",
      "adjust",
      "enabling",
      "enable",
      "disabling",
      "disable",
      "option",
      "options",
      "setting",
      "settings",
      "parameter",
      "parameters",
      "mode",
      "size",
      "scale",
      "offset",
      "anchor",
      "alignment",
      "color",
      "texture",
      "lifetime",
      "amount",
      "visibility",
      "layer",
      "mask",
      "shadow",
      "light",
      "antialiasing",
      "collision shape",
      "particle",
      "attractor",
      "emission",
      "trail",
      "turbulence",
      "container",
      "stretch",
      "resolution",
      "viewport",
      "canvas",
      "transform",
      "coordinate",
      "camera",
      "joint",
      "ragdoll",
      "cloak",
      "softbody",
      "worldboundary",
      "area3d",
      "spring arm",
      "decoration",
      "gameplay element",
      "fade",
      "blend",
      "bbcode",
      "text effect",
      "url",
      "bullet",
      "hdr",
      "tonemap",
      "variable rate shading",
      "lod",
      "draw pass",
      "sub-emitter",
      "axis",
      "rotation",
      "tilt",
      "sprite sheet",
      "parallax",
      "repeat",
      "audiostream",
      "filter",
      "limiter",
      "decibel",
      "doppler",
    ],
  },
  {
    id: "t1:node_add",
    kind: "action",
    tier: "T1",
    via: "gd_node_add plus gd_scene_node_set_property",
    match: ["adding", "add a", "add the", "creating", "create a", "using the", "using a", "using ", "nodes", "node"],
  },
];

/**
 * Page-scoped sweeps for the residue the keyword rules above do not reach.
 * These run last, so they only ever claim headings nothing else matched, which
 * is why they can be broad: on these pages every remaining heading genuinely
 * belongs to the tier named.
 */
const RESIDUE_RULES: SectionRule[] = [
  {
    id: "t0:import_option_names",
    kind: "action",
    tier: "T0",
    via: "gd_import_settings; the residue on these pages is individual .import options",
    pages: ["tutorials/assets_pipeline"],
    match: [""],
  },
  {
    id: "t0:audio_effect_names",
    kind: "action",
    tier: "T0",
    via: "gd_audio (bus_effect add/remove/set_enabled)",
    pages: ["tutorials/audio/audio_effects", "tutorials/audio/audio_buses"],
    match: [""],
  },
  {
    id: "t2:custom_draw_page",
    kind: "action",
    tier: "T2",
    via: "gd_render debug_draw covers a fixed primitive set; arbitrary _draw() work needs a script",
    pages: ["tutorials/2d/custom_drawing_in_2d"],
    match: [""],
  },
  {
    id: "t2:tilemap_editor_page",
    kind: "action",
    tier: "T2",
    via: "the TileMap editor's paint tools have no semantic equivalent; gd_tilemap writes cells one at a time",
    pages: ["tutorials/2d/using_tilemaps", "tutorials/2d/using_tilesets"],
    match: [""],
  },
  {
    id: "t3:project_manager_page",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui; the project manager is a separate editor mode with no semantic surface",
    pages: ["tutorials/editor/project_manager", "tutorials/editor/using_the_android_editor", "tutorials/editor/using_the_web_editor", "tutorials/editor/using_the_xr_editor", "tutorials/editor/managing_editor_features", "tutorials/editor/customizing_editor", "tutorials/editor/external_editor", "tutorials/editor/game_embedding", "tutorials/editor/index"],
    match: [""],
  },
  {
    id: "t0:command_line_page",
    kind: "action",
    tier: "T0",
    via: "gd_editor_launch / gd_play / gd_export_project drive the same operations the CLI does",
    pages: ["tutorials/editor/command_line_tutorial"],
    match: [""],
  },
  {
    // The page-wide backstop, kept so nothing on tutorials/i18n falls through
    // unclassified. The headings gd_translations reaches are taken by
    // t0:translation_registration before this rule is consulted; what remains
    // is the POT half and the text-shaping prose.
    id: "t2:i18n_page",
    kind: "action",
    tier: "T2",
    via: "gd_translations registers translations, remaps, and the fallback and test locale; POT extraction and the text-shaping tutorials have no semantic verb",
    pages: ["tutorials/i18n"],
    match: [""],
  },
  {
    // The static-call cluster, and the reason phase 19 exists. FileAccess and
    // DirAccess were always RefCounted, so gd_object could build one; what was
    // missing is that open() is static, so the instance a handle held was never
    // an open file. class:<Class> closes that, and the same door opens the
    // other static factories this page turns on: Image.load_from_file,
    // AudioStreamOggVorbis/MP3.load_from_file, and JSON.stringify, each
    // confirmed static in 4.7 rather than assumed.
    id: "t1:io_static_factory",
    kind: "action",
    tier: "T1",
    via: "gd_node_call / gd_scene_node_call with target: class:<Class> for a static method -- FileAccess.open and DirAccess.open (phase 19 acceptance), Image.load_from_file, AudioStream*.load_from_file, JSON.stringify -- with capture naming the object that comes back",
    pages: ["tutorials/io"],
    match: [
      "accessing persistent user data",
      "images",
      "audio/video files",
      "serializing",
    ],
  },
  {
    // Reachable since phase 16, and the page-wide rule went on calling it
    // unreachable for three phases. Both pairs are RefCounted and both
    // construct through gd_scene_object create, checked rather than inferred.
    id: "t1:io_object_handle",
    kind: "action",
    tier: "T1",
    via: "gd_object / gd_scene_object create builds ZIPReader, ZIPPacker, GLTFDocument, and GLTFState, and gd_node_call drives them from the handle",
    pages: ["tutorials/io"],
    match: ["3d scenes", "zip archives"],
  },
  {
    // Reachable since phase 10. globalize_path is an instance method on the
    // ProjectSettings singleton, not a static one, and answers today: it was
    // never behind the gap the old rule named.
    id: "t1:io_path_query",
    kind: "action",
    tier: "T1",
    via: "gd_node_call / gd_scene_node_call with target: singleton:ProjectSettings for globalize_path and localize_path, and singleton:OS for get_data_dir, get_config_dir, and get_cache_dir",
    pages: ["tutorials/io"],
    match: ["converting paths to absolute", "editor data paths"],
  },
  {
    // Groups are how the page picks what to save, and both bridges search by
    // group already.
    id: "t1:io_persist_group",
    kind: "action",
    tier: "T1",
    via: "gd_node_query / gd_scene_node_query find the nodes in a group, and gd_wiring adds a persistent one",
    pages: ["tutorials/io"],
    match: ["identify persistent objects"],
  },
  {
    // What is left on tutorials/io once the actions above are taken: the two
    // page titles that introduce res:// and user://, the separator prose, and
    // the area index. None of them is an action, and grading them as one put
    // prose in the denominator.
    id: "concept:io_paths",
    kind: "concept",
    tier: "T0",
    via: "path notation and area index prose, not actions",
    pages: ["tutorials/io"],
    match: [""],
  },
  {
    id: "t5:xr_residue",
    kind: "action",
    tier: "T5",
    via: "no tool; requires XR hardware and a runtime the bridge cannot simulate",
    pages: ["tutorials/xr"],
    match: [""],
  },
  {
    id: "t1:mesh_authoring",
    kind: "action",
    tier: "T1",
    via: "gd_resource_call reaches mesh and surface construction, and SurfaceTool has had an object handle since phase 16",
    match: ["what a mesh is", "surface", "meshdatatool", "immediatemesh", "decal", "fog volume", "volumetric fog", "occluder", "label3d", "textmesh", "3d text", "optimizing pixels drawn"],
  },
  {
    id: "concept:area_index",
    kind: "concept",
    tier: "T0",
    via: "area index page, not an action",
    pages: ["tutorials/networking/index"],
    match: [""],
  },
  {
    id: "t1:residue_property",
    kind: "action",
    tier: "T1",
    via: "gd_scene_node_set_property / gd_node_set_property on the node the section configures",
    match: [
      "physics",
      "navigation",
      "rendering",
      "audio",
      "input",
      "animation",
      "drawing",
      "selection",
      "sizing",
      "focus",
      "notification",
      "control",
      "video",
      "renderer",
      "environment",
      "compositor",
      "optimization",
      "performance",
      "gravity",
      "overlap",
      "bounc",
      "margin",
      "impulse",
      "contact",
      "kinematic",
      "rigid body",
      "look at",
      "move_and_slide",
      "thread safety",
      "memory usage",
      "face index",
      "display",
      "srgb",
      "linear",
      "hardware",
      "target surface",
      "source mesh",
      "skeleton",
      "transition",
      "sprite",
      "message",
      "button",
      "label",
      "sound",
      "scene",
      "step by step",
      "finishing up",
      "leaving the screen",
      "tools",
      "updating",
      "images",
      "internationalization",
      "games and",
      "beyond controls",
      "ui ",
      "user interface",
      "where to go",
      "best practices",
      "path",
      "exporting",
      "reloading",
      "lsp",
      "plugins",
      "permissions",
      "browser",
      "devices",
      "linux",
      "android",
      "web",
      "controller",
      "gamepad",
      "joystick",
      "dead zone",
      "echo",
      "mobile",
      "certificate",
      "webrtc",
      "tls",
    ],
  },
];

/**
 * Phase 14's corrective pass.
 *
 * Five clusters here were written in `a46ec0c` and never revisited, so they
 * still described the surface as it stood before phases 11 and 12 shipped
 * `gd_scene_node_call`, `gd_resource_call`, and `gd_resource_get_property`.
 * `t2:theme` said a theme could be written blind and not read back; `t2:bake`
 * said only eval reached baking. Both were false when they were read, which is
 * exactly the rot this file's header warns hand-written tables drift into.
 * `t2:shader_author` was worse than stale: a page-wide catch-all with
 * `match: [""]` that graded all 101 headings on every shaders page as actions
 * with not one concept among them, including 41 headings of prose about
 * formatting and about porting GLSL.
 *
 * The criterion applied, stated once so each rule below can be checked against
 * it rather than taken on trust:
 *
 * - The action is a method or property on a resource or node the target grammar
 *   can name -> T1. Verified against the 4.7 reference rather than assumed:
 *   `Theme.set_color`/`set_stylebox`/`set_type_variation`, `TileSet.add_source`/
 *   `add_terrain_set`/`add_pattern`, `TileSetAtlasSource.create_tile`,
 *   `Animation.add_track`/`track_insert_key`/`bezier_track_insert_key`,
 *   `AnimationNodeBlendTree.add_node`, `VisualShader.add_node`/`connect_nodes`,
 *   and `VoxelGI.bake` all exist and are reachable through `gd_resource_call`,
 *   `gd_node_call`, or the property tools.
 * - The action is an editor button or panel with no scriptable equivalent -> T3.
 *   Also verified: `LightmapGI` has zero methods in the reference, and
 *   `OccluderInstance3D` has only `get_bake_mask_value`/`set_bake_mask_value`,
 *   so "Bake Lightmaps" and "Bake occluders" really are buttons rather than
 *   tools nobody got round to writing.
 * - The heading explains a language or a style rather than instructing anyone to
 *   do something -> concept, and out of the denominator.
 * - The action needs an object nothing can name -> stays T2, and names it.
 *
 * Deliberately not claimed: nothing here becomes T0 via `gd_shader_validate`.
 * The shader tutorials contain no "check that it compiles" heading to claim, and
 * matching one anyway so the new tool showed up in this half would be the same
 * dishonesty the pass exists to correct. Its coverage is in the class reference
 * and in the section 8 table, where it is real.
 */
const PHASE14_RULES: SectionRule[] = [
  {
    id: "concept:shader_style",
    kind: "concept",
    tier: "T0",
    via: "formatting and naming conventions for shader source, not an engine action",
    pages: ["tutorials/shaders/shaders_style_guide"],
    match: [""],
  },
  {
    id: "concept:glsl_translation",
    kind: "concept",
    tier: "T0",
    via: "a language-difference reference for porting GLSL and Shadertoy code, not an engine action",
    pages: ["tutorials/shaders/converting_glsl_to_godot_shaders"],
    match: [""],
  },
  {
    id: "concept:shaders_index",
    kind: "concept",
    tier: "T0",
    via: "area index page, not an action",
    pages: ["tutorials/shaders/index"],
    match: [""],
  },
  {
    id: "concept:theme_area_index",
    kind: "concept",
    tier: "T0",
    via: "index entry naming the area, not an action",
    match: ["gui skinning and themes"],
  },
  {
    id: "t3:shader_editor_window",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui; an editor window layout, with no resource behind it",
    match: ["splitting the script or shader editor"],
  },
  {
    id: "t3:visual_shader_editor",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui; the graph editor's own interface, as distinct from the VisualShader resource it edits",
    pages: ["tutorials/shaders/visual_shaders"],
    match: ["using the visual shader editor", "visual shader node interface"],
  },
  {
    // Split in phase 18, on a measurement rather than on the inference that
    // phase 16 closed the page. Obtaining the device is reachable: it arrives
    // as the return value of a RenderingServer call and capture takes a handle
    // on it. Everything built on the device is not, for the reason the page
    // rule below now gives.
    id: "t1:local_rendering_device",
    kind: "action",
    tier: "T1",
    via: "gd_node_call / gd_scene_node_call on singleton:RenderingServer with capture: true holds the returned RenderingDevice as an object handle; the engine answers null unless the renderer is RenderingDevice-based (docs/api-gaps.md)",
    pages: ["tutorials/shaders/compute_shaders"],
    match: ["create a local renderingdevice"],
  },
  {
    // The buffer half of the page, which the phase 19 RID form earned and the
    // phase 18 runner now measures: storage_buffer_create hands back a tagged
    // RID, buffer_get_data spends it and reads the bytes, and free_rid spends
    // it again.
    id: "t1:compute_buffer",
    kind: "action",
    tier: "T1",
    via: "gd_scene_node_call on the captured RenderingDevice handle: storage_buffer_create returns {__type:RID}, buffer_get_data and free_rid take one back (phase 18 acceptance, rerun after phase 19)",
    pages: ["tutorials/shaders/compute_shaders"],
    match: ["provide input data", "retrieving results", "freeing memory"],
  },
  {
    // What is left, and why it is left. The RID gap the previous rule named is
    // closed, and RDShaderSource, RDShaderFile, RDUniform, and RDShaderSPIRV
    // all construct through gd_scene_object create -- so the remaining doubt is
    // not a missing mechanism but an unmeasured one: the SPIR-V compile chain
    // and uniform_set_create, whose first argument is a typed Array[RDUniform]
    // that the untyped array an args list builds may or may not satisfy.
    // Graded on what a runner reaches, not on what the mechanism suggests.
    id: "t2:compute_shader",
    kind: "action",
    tier: "T2",
    via: "the RID gap is closed and every RD* helper class constructs by handle, but the SPIR-V chain (RDShaderSource -> shader_compile_spirv_from_source -> shader_create_from_spirv) and uniform_set_create's typed Array[RDUniform] argument are undemonstrated (docs/api-gaps.md)",
    pages: ["tutorials/shaders/compute_shaders"],
    match: [""],
  },
  {
    id: "t1:visual_shader_graph",
    kind: "action",
    tier: "T1",
    via: "gd_resource_create plus gd_resource_call on VisualShader (add_node, connect_nodes, set_mode)",
    pages: ["tutorials/shaders/visual_shaders"],
    match: [""],
  },
  {
    id: "t1:shader_source",
    kind: "action",
    tier: "T1",
    via: "gd_resource_create plus gd_resource_set_property on Shader.code, read back with gd_resource_get_property; gd_shader_validate then compiles it and returns line-numbered diagnostics",
    pages: ["tutorials/shaders"],
    match: [""],
  },
  {
    id: "t1:shader_source_elsewhere",
    kind: "action",
    tier: "T1",
    via: "gd_resource_set_property on Shader.code, with gd_resource_call on Image for the blit operations",
    match: ["custom fogvolume shader", "writing the custom shader", "blitting", "blit shaders"],
  },
  {
    id: "t3:theme_editor",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui; the theme editor's preview and item-management panels, as distinct from the Theme resource they edit",
    pages: ["tutorials/ui/gui_using_theme_editor"],
    match: ["using the theme editor", "theme previews", "manage and import items"],
  },
  {
    id: "t1:theme_resource",
    kind: "action",
    tier: "T1",
    via: "gd_resource_create plus gd_resource_call on Theme (set_color, set_stylebox, set_theme_item, set_type_variation), and gd_resource_get_property to read it back",
    match: ["theme", "stylebox", "ui theme", "customizing a control", "customizing a project", "beyond controls"],
  },
  {
    id: "t3:lightmap_bake_button",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui; LightmapGI has no methods at all in the 4.7 reference, so Bake Lightmaps is a plugin toolbar button with no scriptable equivalent",
    pages: ["tutorials/3d/global_illumination/using_lightmap_gi"],
    match: ["baking", "unwrap from within godot"],
  },
  {
    id: "t3:occluder_bake_button",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui; OccluderInstance3D exposes only its bake mask accessors, so baking occluders and previewing the result are editor actions",
    pages: ["tutorials/3d/occlusion_culling"],
    match: ["automatically baking occluders", "previewing occlusion culling"],
  },
  {
    id: "t1:gi_configuration",
    kind: "action",
    tier: "T1",
    via: "gd_scene_node_set_property and gd_node_call on the GI nodes; VoxelGI.bake is a method, and SDFGI, reflection probe, occlusion and lightmap quality settings are node and environment properties",
    match: ["lightmap", "bake", "baking", "occlusion culling", "occludee", "voxelgi", "voxel gi", "sdfgi", "reflection probe", "global illumination"],
  },
  {
    id: "t1:tileset_authoring",
    kind: "action",
    tier: "T1",
    via: "gd_resource_call on TileSet (add_source, add_terrain_set, add_terrain, add_pattern, add_physics_layer) and on TileSetAtlasSource (create_tile, create_alternative_tile)",
    match: [
      "tileset",
      "terrain set",
      "tile source",
      "atlas",
      "physics layer",
      "custom data layer",
      "premade tile placements",
      "patterns",
      "tilesheet",
      "collection of scenes",
      "alternative tiles",
      "assigning properties to multiple tiles",
    ],
  },
  {
    id: "t3:animation_editor_panel",
    kind: "action",
    tier: "T3",
    via: "gd_editor_ui; the animation editor's own timeline, as distinct from the Animation resource it edits",
    match: ["using the animation editor"],
  },
  {
    id: "t1:animation_authoring",
    kind: "action",
    tier: "T1",
    via: "gd_resource_call on Animation (add_track, track_insert_key, bezier_track_insert_key, audio_track_insert_key) and on AnimationNodeBlendTree (add_node, connect_node); gd_animation itself still creates value tracks only, a convenience gap rather than a capability gap (docs/api-gaps.md)",
    match: [
      "animation track",
      "track type",
      "bezier curve track",
      "call method track",
      "blend shape",
      "audio playback track",
      "animation playback track",
      "property track",
      "animation editor",
      "keyframe",
      "root motion",
      "blendspace",
      "blend tree",
      "oneshot",
      "timeseek",
      "timescale",
      "animationtree",
      "state machine",
      "statemachine",
      "advance condition",
    ],
  },
];

export const SECTION_RULES: SectionRule[] = [
  ...CONCEPT_RULES,
  ...EXTERNAL_RULES,
  ...T0_RULES,
  ...T5_RULES,
  ...T3_RULES,
  ...PHASE14_RULES,
  ...T2_RULES,
  ...T1_RULES,
  ...RESIDUE_RULES,
];
