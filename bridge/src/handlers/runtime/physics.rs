//! Physics and navigation queries (section 8 "Physics and navigation"):
//! raycasts, point and shape intersections, world gravity, and navigation
//! paths and baking, in both dimensions behind one op discriminator.
//!
//! Queries run on the main thread between physics steps, which is safe under
//! the default single-threaded physics; with `run_on_separate_thread` enabled
//! the engine may reject them as space-locked (docs/api-gaps.md). The
//! navigation server classes are gated behind gdext's experimental API
//! feature, so navigation goes through dynamic calls (docs/api-gaps.md).
//! Body configuration (mass, damping, friction, joints) is plain node
//! properties, covered by `gd_node_set_property` and `gd_tree_mutate add_node`.

use godot::builtin::{Rid, Transform2D, Transform3D};
use godot::classes::{
    BoxShape3D, CircleShape2D, Engine, PhysicsDirectSpaceState2D, PhysicsDirectSpaceState3D,
    PhysicsPointQueryParameters2D, PhysicsPointQueryParameters3D, PhysicsRayQueryParameters2D,
    PhysicsRayQueryParameters3D, PhysicsServer2D, PhysicsServer3D,
    PhysicsShapeQueryParameters2D, PhysicsShapeQueryParameters3D, RectangleShape2D,
    SphereShape3D, World2D, World3D,
};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{
    optional_bool, optional_f64, optional_u64, require_str, resolve_node, scene_root,
};
use crate::protocol::BridgeError;
use crate::variant_json::{to_vector2, to_vector3, variant_to_json, vector2_json, vector3_json};

pub fn physics(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        let two_d = match require_str(args, "dimension")?.as_str() {
            "2d" => true,
            "3d" => false,
            other => {
                return Err(BridgeError::InvalidArgs(format!(
                    "unknown dimension '{other}'; expected 2d or 3d"
                )));
            }
        };
        match op.as_str() {
            "raycast" => {
                if two_d {
                    raycast_2d(args)
                } else {
                    raycast_3d(args)
                }
            }
            "intersect_point" => {
                if two_d {
                    intersect_point_2d(args)
                } else {
                    intersect_point_3d(args)
                }
            }
            "intersect_shape" => {
                if two_d {
                    intersect_shape_2d(args)
                } else {
                    intersect_shape_3d(args)
                }
            }
            "nav_path" => nav_path(args, two_d),
            "nav_bake" => nav_bake(args, two_d),
            "world_get" => world_state(two_d),
            "world_set" => world_set(args, two_d),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected raycast, intersect_point, intersect_shape, nav_path, nav_bake, world_get, or world_set"
            ))),
        }
    })())
}

fn world_2d() -> Result<Gd<World2D>, BridgeError> {
    scene_root()?
        .find_world_2d()
        .ok_or_else(|| BridgeError::CallFailed("no 2D world on the root viewport".into()))
}

fn world_3d() -> Result<Gd<World3D>, BridgeError> {
    scene_root()?
        .find_world_3d()
        .ok_or_else(|| BridgeError::CallFailed("no 3D world on the root viewport".into()))
}

fn space_2d() -> Result<Gd<PhysicsDirectSpaceState2D>, BridgeError> {
    world_2d()?
        .get_direct_space_state()
        .ok_or_else(|| BridgeError::CallFailed("2D physics space is unavailable".into()))
}

fn space_3d() -> Result<Gd<PhysicsDirectSpaceState3D>, BridgeError> {
    world_3d()?
        .get_direct_space_state()
        .ok_or_else(|| BridgeError::CallFailed("3D physics space is unavailable".into()))
}

fn collision_mask(args: &Value) -> u32 {
    optional_u64(args, "collision_mask").map(|mask| mask as u32).unwrap_or(u32::MAX)
}

fn max_results(args: &Value) -> i32 {
    optional_u64(args, "max_results").map(|n| n.clamp(1, 256) as i32).unwrap_or(8)
}

/// The collider fields shared by every hit record: absolute node path where
/// the collider is a node, class name, shape index, and object id.
fn hit_common(dict: &VarDictionary) -> Value {
    let collider = dict.get(&GString::from("collider"));
    let (path, class) = match collider.and_then(|c| c.try_to::<Gd<Node>>().ok()) {
        Some(node) => {
            (json!(node.get_path().to_string()), json!(node.get_class().to_string()))
        }
        None => (Value::Null, Value::Null),
    };
    json!({
        "collider_path": path,
        "collider_class": class,
        "shape": dict.get(&GString::from("shape")).map(|v| variant_to_json(&v)).unwrap_or(Value::Null),
        "collider_id": dict.get(&GString::from("collider_id")).map(|v| variant_to_json(&v)).unwrap_or(Value::Null),
    })
}

fn ray_hit(dict: &VarDictionary) -> Value {
    if dict.is_empty() {
        return json!({ "hit": false });
    }
    let mut hit = hit_common(dict);
    hit["hit"] = json!(true);
    for key in ["position", "normal"] {
        hit[key] = dict.get(&GString::from(key)).map(|v| variant_to_json(&v)).unwrap_or(Value::Null);
    }
    hit
}

fn raycast_2d(args: &Value) -> Result<Value, BridgeError> {
    let from = to_vector2(require_field(args, "from")?)?;
    let to = to_vector2(require_field(args, "to")?)?;
    let mut params = PhysicsRayQueryParameters2D::create(from, to)
        .ok_or_else(|| BridgeError::Internal("ray parameter construction failed".into()))?;
    params.set_collision_mask(collision_mask(args));
    params.set_collide_with_areas(optional_bool(args, "collide_with_areas").unwrap_or(false));
    params.set_hit_from_inside(optional_bool(args, "hit_from_inside").unwrap_or(false));
    Ok(ray_hit(&space_2d()?.intersect_ray(&params)))
}

fn raycast_3d(args: &Value) -> Result<Value, BridgeError> {
    let from = to_vector3(require_field(args, "from")?)?;
    let to = to_vector3(require_field(args, "to")?)?;
    let mut params = PhysicsRayQueryParameters3D::create(from, to)
        .ok_or_else(|| BridgeError::Internal("ray parameter construction failed".into()))?;
    params.set_collision_mask(collision_mask(args));
    params.set_collide_with_areas(optional_bool(args, "collide_with_areas").unwrap_or(false));
    params.set_hit_from_inside(optional_bool(args, "hit_from_inside").unwrap_or(false));
    Ok(ray_hit(&space_3d()?.intersect_ray(&params)))
}

fn hits_json(hits: Array<VarDictionary>) -> Value {
    let items: Vec<Value> = hits.iter_shared().map(|dict| hit_common(&dict)).collect();
    json!({ "count": items.len(), "hits": items })
}

fn intersect_point_2d(args: &Value) -> Result<Value, BridgeError> {
    let position = to_vector2(require_field(args, "position")?)?;
    let mut params = PhysicsPointQueryParameters2D::new_gd();
    params.set_position(position);
    params.set_collision_mask(collision_mask(args));
    params.set_collide_with_areas(optional_bool(args, "collide_with_areas").unwrap_or(false));
    let hits = space_2d()?.intersect_point_ex(&params).max_results(max_results(args)).done();
    Ok(hits_json(hits))
}

fn intersect_point_3d(args: &Value) -> Result<Value, BridgeError> {
    let position = to_vector3(require_field(args, "position")?)?;
    let mut params = PhysicsPointQueryParameters3D::new_gd();
    params.set_position(position);
    params.set_collision_mask(collision_mask(args));
    params.set_collide_with_areas(optional_bool(args, "collide_with_areas").unwrap_or(false));
    let hits = space_3d()?.intersect_point_ex(&params).max_results(max_results(args)).done();
    Ok(hits_json(hits))
}

// Only the primitive kinds; richer shapes go through gd_game_eval.
fn intersect_shape_2d(args: &Value) -> Result<Value, BridgeError> {
    let shape_args = require_field(args, "shape")?;
    let kind = shape_args
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::InvalidArgs("'shape.kind' is required".into()))?;
    let shape: Gd<godot::classes::Shape2D> = match kind {
        "circle" => {
            let mut circle = CircleShape2D::new_gd();
            circle.set_radius(shape_field_f32(shape_args, "radius")?);
            circle.upcast()
        }
        "rectangle" => {
            let mut rect = RectangleShape2D::new_gd();
            rect.set_size(to_vector2(require_field(shape_args, "size")?)?);
            rect.upcast()
        }
        other => {
            return Err(BridgeError::InvalidArgs(format!(
                "unknown 2d shape kind '{other}'; expected circle or rectangle"
            )));
        }
    };
    let position = to_vector2(require_field(args, "position")?)?;
    let mut transform = Transform2D::IDENTITY;
    transform.origin = position;
    let mut params = PhysicsShapeQueryParameters2D::new_gd();
    params.set_shape(&shape);
    params.set_transform(transform);
    params.set_collision_mask(collision_mask(args));
    let hits = space_2d()?.intersect_shape_ex(&params).max_results(max_results(args)).done();
    Ok(hits_json(hits))
}

fn intersect_shape_3d(args: &Value) -> Result<Value, BridgeError> {
    let shape_args = require_field(args, "shape")?;
    let kind = shape_args
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::InvalidArgs("'shape.kind' is required".into()))?;
    let shape: Gd<godot::classes::Shape3D> = match kind {
        "sphere" => {
            let mut sphere = SphereShape3D::new_gd();
            sphere.set_radius(shape_field_f32(shape_args, "radius")?);
            sphere.upcast()
        }
        "box" => {
            let mut cuboid = BoxShape3D::new_gd();
            cuboid.set_size(to_vector3(require_field(shape_args, "size")?)?);
            cuboid.upcast()
        }
        other => {
            return Err(BridgeError::InvalidArgs(format!(
                "unknown 3d shape kind '{other}'; expected sphere or box"
            )));
        }
    };
    let position = to_vector3(require_field(args, "position")?)?;
    let mut transform = Transform3D::IDENTITY;
    transform.origin = position;
    let mut params = PhysicsShapeQueryParameters3D::new_gd();
    params.set_shape(&shape);
    params.set_transform(transform);
    params.set_collision_mask(collision_mask(args));
    let hits = space_3d()?.intersect_shape_ex(&params).max_results(max_results(args)).done();
    Ok(hits_json(hits))
}

fn navigation_server(two_d: bool) -> Result<Gd<Object>, BridgeError> {
    let name = if two_d { "NavigationServer2D" } else { "NavigationServer3D" };
    Engine::singleton()
        .get_singleton(name)
        .ok_or_else(|| BridgeError::CallFailed(format!("{name} singleton is unavailable")))
}

// An unbaked map legitimately yields an empty path, not an error.
fn nav_path(args: &Value, two_d: bool) -> Result<Value, BridgeError> {
    let optimize = optional_bool(args, "optimize").unwrap_or(true);
    let mut server = navigation_server(two_d)?;
    let (map, from, to): (Rid, Variant, Variant) = if two_d {
        (
            world_2d()?.get_navigation_map(),
            to_vector2(require_field(args, "from")?)?.to_variant(),
            to_vector2(require_field(args, "to")?)?.to_variant(),
        )
    } else {
        (
            world_3d()?.get_navigation_map(),
            to_vector3(require_field(args, "from")?)?.to_variant(),
            to_vector3(require_field(args, "to")?)?.to_variant(),
        )
    };
    let result = server.call(
        "map_get_path",
        &[map.to_variant(), from, to, optimize.to_variant()],
    );
    let points: Vec<Value> = if two_d {
        result
            .try_to::<PackedVector2Array>()
            .unwrap_or_default()
            .as_slice()
            .iter()
            .map(|p| vector2_json(*p))
            .collect()
    } else {
        result
            .try_to::<PackedVector3Array>()
            .unwrap_or_default()
            .as_slice()
            .iter()
            .map(|p| vector3_json(*p))
            .collect()
    };
    Ok(json!({ "count": points.len(), "points": points }))
}

// Baking is asynchronous even on-thread; completion is awaitable through
// gd_signal on the region's bake_finished signal.
fn nav_bake(args: &Value, two_d: bool) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let on_thread = optional_bool(args, "on_thread").unwrap_or(false);
    let method = if two_d { "bake_navigation_polygon" } else { "bake_navigation_mesh" };
    let mut node = resolve_node(&node_path)?;
    if !node.has_method(method) {
        return Err(BridgeError::InvalidArgs(format!(
            "node at {node_path} ({}) has no {method}; expected a NavigationRegion{}",
            node.get_class(),
            if two_d { "2D" } else { "3D" }
        )));
    }
    node.call(method, &[on_thread.to_variant()]);
    Ok(json!({ "requested": true, "node_path": node_path, "method": method }))
}

// The world's default gravity lives on the space's default area; the physics
// servers accept the space RID for it (the documented runtime-change path).
fn world_state(two_d: bool) -> Result<Value, BridgeError> {
    let (gravity, gravity_vector) = if two_d {
        let space = world_2d()?.get_space();
        let server = PhysicsServer2D::singleton();
        (
            server.area_get_param(space, godot::classes::physics_server_2d::AreaParameter::GRAVITY),
            server.area_get_param(
                space,
                godot::classes::physics_server_2d::AreaParameter::GRAVITY_VECTOR,
            ),
        )
    } else {
        let space = world_3d()?.get_space();
        let server = PhysicsServer3D::singleton();
        (
            server.area_get_param(space, godot::classes::physics_server_3d::AreaParameter::GRAVITY),
            server.area_get_param(
                space,
                godot::classes::physics_server_3d::AreaParameter::GRAVITY_VECTOR,
            ),
        )
    };
    Ok(json!({
        "gravity": variant_to_json(&gravity),
        "gravity_vector": variant_to_json(&gravity_vector),
        "physics_ticks_per_second": Engine::singleton().get_physics_ticks_per_second(),
    }))
}

fn world_set(args: &Value, two_d: bool) -> Result<Value, BridgeError> {
    if let Some(gravity) = optional_f64(args, "gravity") {
        set_area_param_gravity(two_d, gravity)?;
    }
    if let Some(vector) = args.get("gravity_vector") {
        set_area_param_gravity_vector(two_d, vector)?;
    }
    if let Some(ticks) = optional_u64(args, "physics_ticks_per_second") {
        if !(1..=1000).contains(&ticks) {
            return Err(BridgeError::InvalidArgs(
                "'physics_ticks_per_second' must be between 1 and 1000".into(),
            ));
        }
        Engine::singleton().set_physics_ticks_per_second(ticks as i32);
    }
    world_state(two_d)
}

fn set_area_param_gravity(two_d: bool, gravity: f64) -> Result<(), BridgeError> {
    if two_d {
        let space = world_2d()?.get_space();
        PhysicsServer2D::singleton().area_set_param(
            space,
            godot::classes::physics_server_2d::AreaParameter::GRAVITY,
            &gravity.to_variant(),
        );
    } else {
        let space = world_3d()?.get_space();
        PhysicsServer3D::singleton().area_set_param(
            space,
            godot::classes::physics_server_3d::AreaParameter::GRAVITY,
            &gravity.to_variant(),
        );
    }
    Ok(())
}

fn set_area_param_gravity_vector(two_d: bool, vector: &Value) -> Result<(), BridgeError> {
    if two_d {
        let space = world_2d()?.get_space();
        PhysicsServer2D::singleton().area_set_param(
            space,
            godot::classes::physics_server_2d::AreaParameter::GRAVITY_VECTOR,
            &to_vector2(vector)?.to_variant(),
        );
    } else {
        let space = world_3d()?.get_space();
        PhysicsServer3D::singleton().area_set_param(
            space,
            godot::classes::physics_server_3d::AreaParameter::GRAVITY_VECTOR,
            &to_vector3(vector)?.to_variant(),
        );
    }
    Ok(())
}

fn require_field<'a>(args: &'a Value, key: &str) -> Result<&'a Value, BridgeError> {
    args.get(key).ok_or_else(|| BridgeError::InvalidArgs(format!("'{key}' is required")))
}

fn shape_field_f32(shape: &Value, key: &str) -> Result<f32, BridgeError> {
    shape
        .get(key)
        .and_then(Value::as_f64)
        .map(|n| n as f32)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("'shape.{key}' must be a number")))
}
