//! Rendering and environment control (section 8 "Rendering and environment"):
//! cameras, world environment, viewport render settings, and debug draw.
//!
//! Lights and camera attribute resources are plain node and resource
//! properties, covered by the generic property tools (docs/api-gaps.md).
//! Debug draw renders through bridge-owned nodes added under the scene root:
//! a custom Node2D replaying primitives in draw, and a MeshInstance3D whose
//! ImmediateMesh is rebuilt as line lists. Headless, the ops still track
//! primitive state; only the pixels are absent.

use godot::builtin::{Color, Rect2, Vector2, Vector3};
use godot::classes::mesh::PrimitiveType;
use godot::classes::{
    Camera2D, Camera3D, Environment, ImmediateMesh, INode2D, MeshInstance3D, Node2D,
    WorldEnvironment,
};
use godot::prelude::*;
use serde_json::{json, Map, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{
    apply_properties, optional_bool, optional_f64, optional_properties, optional_str,
    require_str, resolve_node, scene_root,
};
use crate::protocol::BridgeError;
use crate::variant_json::{to_color, to_vector2, to_vector3, variant_to_json};

pub fn render(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "camera_get" => camera_get(args),
            "camera_set" => camera_set(args),
            "environment_get" => environment_get(args),
            "environment_set" => environment_set(args),
            "viewport_get" => viewport_get(args),
            "viewport_set" => viewport_set(args),
            "debug_draw" => debug_draw(args),
            "debug_clear" => debug_clear(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected camera_get, camera_set, environment_get, environment_set, viewport_get, viewport_set, debug_draw, or debug_clear"
            ))),
        }
    })())
}

fn two_d(args: &Value) -> Result<bool, BridgeError> {
    match require_str(args, "dimension")?.as_str() {
        "2d" => Ok(true),
        "3d" => Ok(false),
        other => {
            Err(BridgeError::InvalidArgs(format!("unknown dimension '{other}'; expected 2d or 3d")))
        }
    }
}

fn object_snapshot(object: &Gd<Object>, keys: &[&str]) -> Value {
    let mut map = Map::new();
    for key in keys {
        map.insert((*key).to_string(), variant_to_json(&object.get(*key)));
    }
    Value::Object(map)
}

const CAMERA_2D_KEYS: &[&str] = &["offset", "zoom", "rotation", "position", "enabled"];
const CAMERA_3D_KEYS: &[&str] = &["fov", "near", "far", "projection", "position", "current"];

fn camera_get(args: &Value) -> Result<Value, BridgeError> {
    let root = scene_root()?;
    if two_d(args)? {
        match root.get_camera_2d() {
            Some(camera) => Ok(camera_json(&camera.upcast::<Node>(), CAMERA_2D_KEYS)),
            None => Ok(json!({ "path": Value::Null })),
        }
    } else {
        match root.get_camera_3d() {
            Some(camera) => Ok(camera_json(&camera.upcast::<Node>(), CAMERA_3D_KEYS)),
            None => Ok(json!({ "path": Value::Null })),
        }
    }
}

fn camera_json(camera: &Gd<Node>, keys: &[&str]) -> Value {
    let object = camera.clone().upcast::<Object>();
    let mut snapshot = object_snapshot(&object, keys);
    snapshot["path"] = json!(camera.get_path().to_string());
    snapshot["class"] = json!(camera.get_class().to_string());
    snapshot
}

fn camera_set(args: &Value) -> Result<Value, BridgeError> {
    let is_2d = two_d(args)?;
    let root = scene_root()?;
    let node = match optional_str(args, "node_path") {
        Some(path) => resolve_node(&path)?,
        None => {
            let current: Option<Gd<Node>> = if is_2d {
                root.get_camera_2d().map(Gd::upcast)
            } else {
                root.get_camera_3d().map(Gd::upcast)
            };
            current.ok_or_else(|| {
                BridgeError::InvalidArgs("no current camera; pass node_path".into())
            })?
        }
    };
    if let Some(properties) = optional_properties(args)? {
        let mut object = node.clone().upcast::<Object>();
        apply_properties(&mut object, properties)?;
    }
    if optional_bool(args, "make_current").unwrap_or(false) {
        make_current(&node, is_2d)?;
    }
    Ok(camera_json(&node, if is_2d { CAMERA_2D_KEYS } else { CAMERA_3D_KEYS }))
}

fn make_current(node: &Gd<Node>, is_2d: bool) -> Result<(), BridgeError> {
    if is_2d {
        let mut camera = node.clone().try_cast::<Camera2D>().map_err(|_| {
            BridgeError::InvalidArgs(format!("{} is not a Camera2D", node.get_class()))
        })?;
        camera.make_current();
    } else {
        let mut camera = node.clone().try_cast::<Camera3D>().map_err(|_| {
            BridgeError::InvalidArgs(format!("{} is not a Camera3D", node.get_class()))
        })?;
        camera.make_current();
    }
    Ok(())
}

const ENVIRONMENT_KEYS: &[&str] = &[
    "background_mode",
    "ambient_light_color",
    "ambient_light_energy",
    "fog_enabled",
    "glow_enabled",
    "tonemap_mode",
];

fn environment(args: &Value) -> Result<Gd<Environment>, BridgeError> {
    if let Some(path) = optional_str(args, "node_path") {
        let node = resolve_node(&path)?;
        let class = node.get_class().to_string();
        let world_env = node.try_cast::<WorldEnvironment>().map_err(|_| {
            BridgeError::InvalidArgs(format!("node at {path} is {class}, not a WorldEnvironment"))
        })?;
        return world_env.get_environment().ok_or_else(|| {
            BridgeError::ResourceError(format!("WorldEnvironment at {path} has no environment resource"))
        });
    }
    scene_root()?
        .find_world_3d()
        .and_then(|world| world.get_environment())
        .ok_or_else(|| {
            BridgeError::ResourceError(
                "no world environment; add a WorldEnvironment node or pass node_path".into(),
            )
        })
}

fn environment_get(args: &Value) -> Result<Value, BridgeError> {
    let environment = environment(args)?;
    let keys: Vec<String> = match args.get("keys").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_string).ok_or_else(|| {
                    BridgeError::InvalidArgs("'keys' must be an array of strings".into())
                })
            })
            .collect::<Result<_, _>>()?,
        None => ENVIRONMENT_KEYS.iter().map(|key| (*key).to_string()).collect(),
    };
    let object = environment.clone().upcast::<Object>();
    let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
    Ok(json!({
        "class": object.get_class().to_string(),
        "properties": object_snapshot(&object, &refs),
    }))
}

fn environment_set(args: &Value) -> Result<Value, BridgeError> {
    let environment = environment(args)?;
    let properties = optional_properties(args)?
        .ok_or_else(|| BridgeError::InvalidArgs("'properties' is required".into()))?;
    let mut object = environment.upcast::<Object>();
    let applied = apply_properties(&mut object, properties)?;
    Ok(json!({ "applied": applied }))
}

const VIEWPORT_KEYS: &[&str] =
    &["msaa_2d", "msaa_3d", "screen_space_aa", "use_debanding", "scaling_3d_mode", "scaling_3d_scale"];

fn viewport_get(_args: &Value) -> Result<Value, BridgeError> {
    let object = scene_root()?.upcast::<Object>();
    Ok(object_snapshot(&object, VIEWPORT_KEYS))
}

fn viewport_set(args: &Value) -> Result<Value, BridgeError> {
    let properties = optional_properties(args)?
        .ok_or_else(|| BridgeError::InvalidArgs("'properties' is required".into()))?;
    let mut object = scene_root()?.upcast::<Object>();
    apply_properties(&mut object, properties)?;
    Ok(object_snapshot(&object, VIEWPORT_KEYS))
}

enum Shape2 {
    Line { from: Vector2, to: Vector2 },
    Circle { center: Vector2, radius: f32 },
    Rect { rect: Rect2 },
}

struct Primitive2D {
    shape: Shape2,
    color: Color,
    remaining: Option<f64>,
}

#[derive(GodotClass)]
#[class(base = Node2D, init)]
struct ConduitDebugDraw2D {
    base: Base<Node2D>,
    primitives: Vec<Primitive2D>,
}

#[godot_api]
impl INode2D for ConduitDebugDraw2D {
    fn draw(&mut self) {
        let primitives = std::mem::take(&mut self.primitives);
        for primitive in &primitives {
            match primitive.shape {
                Shape2::Line { from, to } => {
                    self.base_mut().draw_line(from, to, primitive.color);
                }
                Shape2::Circle { center, radius } => {
                    self.base_mut().draw_circle(center, radius, primitive.color);
                }
                Shape2::Rect { rect } => {
                    self.base_mut().draw_rect(rect, primitive.color);
                }
            }
        }
        self.primitives = primitives;
    }

    fn process(&mut self, delta: f64) {
        if expire(&mut self.primitives, delta, |p| &mut p.remaining) {
            self.base_mut().queue_redraw();
        }
    }
}

enum Shape3 {
    Line { from: Vector3, to: Vector3 },
    Sphere { center: Vector3, radius: f32 },
    Box { center: Vector3, size: Vector3 },
}

struct Primitive3D {
    shape: Shape3,
    color: Color,
    remaining: Option<f64>,
}

#[derive(GodotClass)]
#[class(base = Node3D, init)]
struct ConduitDebugDraw3D {
    base: Base<Node3D>,
    primitives: Vec<Primitive3D>,
    mesh: Option<Gd<ImmediateMesh>>,
}

#[godot_api]
impl godot::classes::INode3D for ConduitDebugDraw3D {
    fn process(&mut self, delta: f64) {
        if expire(&mut self.primitives, delta, |p| &mut p.remaining) {
            self.rebuild();
        }
    }
}

impl ConduitDebugDraw3D {
    fn ensure_mesh(&mut self) -> Gd<ImmediateMesh> {
        if let Some(mesh) = &self.mesh {
            return mesh.clone();
        }
        let mesh = ImmediateMesh::new_gd();
        let mut instance = MeshInstance3D::new_alloc();
        instance.set_mesh(&mesh);
        self.base_mut().add_child(&instance);
        self.mesh = Some(mesh.clone());
        mesh
    }

    // Everything renders as one LINES surface: lines directly, spheres as
    // three axis-aligned circles, boxes as their twelve edges.
    fn rebuild(&mut self) {
        let mut mesh = self.ensure_mesh();
        mesh.clear_surfaces();
        if self.primitives.is_empty() {
            return;
        }
        mesh.surface_begin(PrimitiveType::LINES);
        for primitive in &self.primitives {
            mesh.surface_set_color(primitive.color);
            match primitive.shape {
                Shape3::Line { from, to } => {
                    mesh.surface_add_vertex(from);
                    mesh.surface_add_vertex(to);
                }
                Shape3::Sphere { center, radius } => {
                    for axis in 0..3 {
                        add_circle(&mut mesh, center, radius, axis);
                    }
                }
                Shape3::Box { center, size } => {
                    add_box(&mut mesh, center, size);
                }
            }
        }
        mesh.surface_end();
    }
}

fn add_circle(mesh: &mut Gd<ImmediateMesh>, center: Vector3, radius: f32, axis: usize) {
    const SEGMENTS: usize = 24;
    let point = |i: usize| {
        let angle = (i % SEGMENTS) as f32 / SEGMENTS as f32 * std::f32::consts::TAU;
        let (sin, cos) = angle.sin_cos();
        center
            + match axis {
                0 => Vector3::new(0.0, sin, cos),
                1 => Vector3::new(sin, 0.0, cos),
                _ => Vector3::new(sin, cos, 0.0),
            } * radius
    };
    for i in 0..SEGMENTS {
        mesh.surface_add_vertex(point(i));
        mesh.surface_add_vertex(point(i + 1));
    }
}

fn add_box(mesh: &mut Gd<ImmediateMesh>, center: Vector3, size: Vector3) {
    let half = size / 2.0;
    let corner = |x: f32, y: f32, z: f32| center + Vector3::new(x * half.x, y * half.y, z * half.z);
    let corners = [
        corner(-1.0, -1.0, -1.0),
        corner(1.0, -1.0, -1.0),
        corner(1.0, 1.0, -1.0),
        corner(-1.0, 1.0, -1.0),
        corner(-1.0, -1.0, 1.0),
        corner(1.0, -1.0, 1.0),
        corner(1.0, 1.0, 1.0),
        corner(-1.0, 1.0, 1.0),
    ];
    const EDGES: [(usize, usize); 12] = [
        (0, 1), (1, 2), (2, 3), (3, 0),
        (4, 5), (5, 6), (6, 7), (7, 4),
        (0, 4), (1, 5), (2, 6), (3, 7),
    ];
    for (a, b) in EDGES {
        mesh.surface_add_vertex(corners[a]);
        mesh.surface_add_vertex(corners[b]);
    }
}

/// Tick down timed primitives, dropping the expired. Returns whether the list
/// changed, so callers only redraw when needed.
fn expire<T>(
    primitives: &mut Vec<T>,
    delta: f64,
    remaining: impl Fn(&mut T) -> &mut Option<f64>,
) -> bool {
    let before = primitives.len();
    primitives.retain_mut(|primitive| match remaining(primitive) {
        Some(left) => {
            *left -= delta;
            *left > 0.0
        }
        None => true,
    });
    primitives.len() != before
}

const DRAW_2D_NAME: &str = "ConduitDebugDraw2D";
const DRAW_3D_NAME: &str = "ConduitDebugDraw3D";

fn debug_draw(args: &Value) -> Result<Value, BridgeError> {
    let kind = require_str(args, "kind")?;
    let color = match args.get("color") {
        Some(value) => to_color(value)?,
        None => Color::from_rgba(1.0, 1.0, 1.0, 1.0),
    };
    let remaining = optional_f64(args, "duration");
    if two_d(args)? {
        let shape = match kind.as_str() {
            "line" => Shape2::Line {
                from: to_vector2(require_field(args, "from")?)?,
                to: to_vector2(require_field(args, "to")?)?,
            },
            "circle" => Shape2::Circle {
                center: to_vector2(require_field(args, "center")?)?,
                radius: require_f32(args, "radius")?,
            },
            "rect" => Shape2::Rect {
                rect: Rect2::new(
                    to_vector2(require_field(args, "position")?)?,
                    to_vector2(require_field(args, "size")?)?,
                ),
            },
            other => {
                return Err(BridgeError::InvalidArgs(format!(
                    "unknown 2d kind '{other}'; expected line, circle, or rect"
                )));
            }
        };
        let mut node = draw_node_2d()?;
        let count = {
            let mut draw = node.bind_mut();
            draw.primitives.push(Primitive2D { shape, color, remaining });
            draw.primitives.len()
        };
        node.queue_redraw();
        Ok(json!({ "added": kind, "count": count }))
    } else {
        let shape = match kind.as_str() {
            "line" => Shape3::Line {
                from: to_vector3(require_field(args, "from")?)?,
                to: to_vector3(require_field(args, "to")?)?,
            },
            "sphere" => Shape3::Sphere {
                center: to_vector3(require_field(args, "center")?)?,
                radius: require_f32(args, "radius")?,
            },
            "box" => Shape3::Box {
                center: to_vector3(require_field(args, "center")?)?,
                size: to_vector3(require_field(args, "size")?)?,
            },
            other => {
                return Err(BridgeError::InvalidArgs(format!(
                    "unknown 3d kind '{other}'; expected line, sphere, or box"
                )));
            }
        };
        let mut node = draw_node_3d()?;
        let count = {
            let mut draw = node.bind_mut();
            draw.primitives.push(Primitive3D { shape, color, remaining });
            draw.primitives.len()
        };
        node.bind_mut().rebuild();
        Ok(json!({ "added": kind, "count": count }))
    }
}

fn debug_clear(_args: &Value) -> Result<Value, BridgeError> {
    let root = scene_root()?;
    if let Some(node) = root.get_node_or_null(DRAW_2D_NAME)
        && let Ok(mut draw) = node.try_cast::<ConduitDebugDraw2D>()
    {
        draw.bind_mut().primitives.clear();
        draw.queue_redraw();
    }
    if let Some(node) = root.get_node_or_null(DRAW_3D_NAME)
        && let Ok(mut draw) = node.try_cast::<ConduitDebugDraw3D>()
    {
        let mut bound = draw.bind_mut();
        bound.primitives.clear();
        bound.rebuild();
    }
    Ok(json!({ "cleared": true }))
}

fn draw_node_2d() -> Result<Gd<ConduitDebugDraw2D>, BridgeError> {
    let mut root = scene_root()?;
    if let Some(existing) = root.get_node_or_null(DRAW_2D_NAME) {
        return existing.try_cast::<ConduitDebugDraw2D>().map_err(|_| {
            BridgeError::Internal(format!("{DRAW_2D_NAME} node has an unexpected type"))
        });
    }
    let mut node = ConduitDebugDraw2D::new_alloc();
    node.set_name(DRAW_2D_NAME);
    root.add_child(&node);
    Ok(node)
}

fn draw_node_3d() -> Result<Gd<ConduitDebugDraw3D>, BridgeError> {
    let mut root = scene_root()?;
    if let Some(existing) = root.get_node_or_null(DRAW_3D_NAME) {
        return existing.try_cast::<ConduitDebugDraw3D>().map_err(|_| {
            BridgeError::Internal(format!("{DRAW_3D_NAME} node has an unexpected type"))
        });
    }
    let mut node = ConduitDebugDraw3D::new_alloc();
    node.set_name(DRAW_3D_NAME);
    root.add_child(&node);
    Ok(node)
}

fn require_field<'a>(args: &'a Value, key: &str) -> Result<&'a Value, BridgeError> {
    args.get(key).ok_or_else(|| BridgeError::InvalidArgs(format!("'{key}' is required")))
}

fn require_f32(args: &Value, key: &str) -> Result<f32, BridgeError> {
    args.get(key)
        .and_then(Value::as_f64)
        .map(|n| n as f32)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("'{key}' is required and must be a number")))
}
