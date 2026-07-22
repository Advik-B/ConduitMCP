//! TileMapLayer and GridMap cell access behind one tool (section 8 "2D and 3D
//! systems", phase 8 scope: cells). The target kind is discriminated by the
//! resolved node's class, not an argument; the deprecated TileMap node is
//! rejected with a pointer to TileMapLayer (docs/api-gaps.md).

use godot::builtin::{Aabb, Vector2i, Vector3, Vector3i};
use godot::classes::{GridMap, TileMapLayer};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::classdb::paginate;
use crate::handlers::runtime::support::{optional_u64, require_str, resolve_node};
use crate::protocol::BridgeError;
use crate::variant_json::variant_to_json;

pub fn tilemap(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        let node_path = require_str(args, "node_path")?;
        let node = resolve_node(&node_path)?;
        let class = node.get_class().to_string();
        match node.clone().try_cast::<TileMapLayer>() {
            Ok(layer) => tilemap_op(layer, &op, args),
            Err(_) => match node.try_cast::<GridMap>() {
                Ok(grid) => gridmap_op(grid, &op, args),
                Err(_) => Err(BridgeError::InvalidArgs(if class == "TileMap" {
                    format!(
                        "node at {node_path} is the deprecated TileMap; expected TileMapLayer or GridMap"
                    )
                } else {
                    format!("node at {node_path} is {class}; expected TileMapLayer or GridMap")
                })),
            },
        }
    })())
}

fn unknown_op(op: &str) -> BridgeError {
    BridgeError::InvalidArgs(format!(
        "unknown op '{op}'; expected get_cell, set_cell, erase_cell, used_cells, used_rect, or clear"
    ))
}

fn tilemap_op(mut layer: Gd<TileMapLayer>, op: &str, args: &Value) -> Result<Value, BridgeError> {
    match op {
        "get_cell" => {
            let (x, y) = parse_cell_2d(args)?;
            Ok(tile_cell(&layer, Vector2i::new(x, y)))
        }
        "set_cell" => {
            let (x, y) = parse_cell_2d(args)?;
            let coords = Vector2i::new(x, y);
            let source_id = args.get("source_id").and_then(Value::as_i64).unwrap_or(0) as i32;
            let atlas = match args.get("atlas_coords") {
                Some(value) => {
                    let (ax, ay) = parse_ivec2(value, "atlas_coords")?;
                    Vector2i::new(ax, ay)
                }
                None => Vector2i::ZERO,
            };
            let alternative =
                args.get("alternative_tile").and_then(Value::as_i64).unwrap_or(0) as i32;
            layer
                .set_cell_ex(coords)
                .source_id(source_id)
                .atlas_coords(atlas)
                .alternative_tile(alternative)
                .done();
            Ok(tile_cell(&layer, coords))
        }
        "erase_cell" => {
            let (x, y) = parse_cell_2d(args)?;
            layer.erase_cell(Vector2i::new(x, y));
            Ok(json!({ "erased": true }))
        }
        "used_cells" => {
            let region = parse_region_2d(args)?;
            let cells: Vec<Value> = layer
                .get_used_cells()
                .iter_shared()
                .filter(|coords| {
                    region.is_none_or(|r| cell_in_region_2d((coords.x, coords.y), r))
                })
                .map(|coords| tile_cell(&layer, coords))
                .collect();
            Ok(paginate(cells, limit(args), offset(args)))
        }
        "used_rect" => Ok(json!({ "rect": variant_to_json(&layer.get_used_rect().to_variant()) })),
        "clear" => {
            layer.clear();
            Ok(json!({ "cleared": true }))
        }
        other => Err(unknown_op(other)),
    }
}

fn tile_cell(layer: &Gd<TileMapLayer>, coords: Vector2i) -> Value {
    let source_id = layer.get_cell_source_id(coords);
    let atlas = layer.get_cell_atlas_coords(coords);
    json!({
        "coords": { "x": coords.x, "y": coords.y },
        "source_id": source_id,
        "atlas_coords": { "x": atlas.x, "y": atlas.y },
        "alternative_tile": layer.get_cell_alternative_tile(coords),
        "empty": source_id == -1,
    })
}

fn gridmap_op(mut grid: Gd<GridMap>, op: &str, args: &Value) -> Result<Value, BridgeError> {
    match op {
        "get_cell" => {
            let (x, y, z) = parse_cell_3d(args)?;
            Ok(grid_cell(&grid, Vector3i::new(x, y, z)))
        }
        "set_cell" => {
            let (x, y, z) = parse_cell_3d(args)?;
            let coords = Vector3i::new(x, y, z);
            let item = args
                .get("item")
                .and_then(Value::as_i64)
                .ok_or_else(|| BridgeError::InvalidArgs("'item' is required for GridMap set_cell".into()))?
                as i32;
            let orientation = args.get("orientation").and_then(Value::as_i64).unwrap_or(0) as i32;
            grid.set_cell_item_ex(coords, item).orientation(orientation).done();
            Ok(grid_cell(&grid, coords))
        }
        "erase_cell" => {
            let (x, y, z) = parse_cell_3d(args)?;
            grid.set_cell_item(Vector3i::new(x, y, z), -1);
            Ok(json!({ "erased": true }))
        }
        "used_cells" => {
            let region = parse_region_3d(args)?;
            let cells: Vec<Value> = grid
                .get_used_cells()
                .iter_shared()
                .filter(|coords| {
                    region.is_none_or(|r| cell_in_region_3d((coords.x, coords.y, coords.z), r))
                })
                .map(|coords| grid_cell(&grid, coords))
                .collect();
            Ok(paginate(cells, limit(args), offset(args)))
        }
        // GridMap has no native used-rect; report the min-max cell AABB.
        "used_rect" => {
            let cells: Vec<Vector3i> = grid.get_used_cells().iter_shared().collect();
            if cells.is_empty() {
                return Ok(json!({ "rect": Value::Null }));
            }
            let mut min = cells[0];
            let mut max = cells[0];
            for cell in &cells {
                min = min.coord_min(*cell);
                max = max.coord_max(*cell);
            }
            let aabb = Aabb {
                position: Vector3::new(min.x as f32, min.y as f32, min.z as f32),
                size: Vector3::new(
                    (max.x - min.x + 1) as f32,
                    (max.y - min.y + 1) as f32,
                    (max.z - min.z + 1) as f32,
                ),
            };
            Ok(json!({ "rect": variant_to_json(&aabb.to_variant()) }))
        }
        "clear" => {
            grid.clear();
            Ok(json!({ "cleared": true }))
        }
        other => Err(unknown_op(other)),
    }
}

fn grid_cell(grid: &Gd<GridMap>, coords: Vector3i) -> Value {
    let item = grid.get_cell_item(coords);
    json!({
        "coords": { "x": coords.x, "y": coords.y, "z": coords.z },
        "item": item,
        "orientation": grid.get_cell_item_orientation(coords),
        "empty": item == -1,
    })
}

fn limit(args: &Value) -> u64 {
    optional_u64(args, "limit").map(|l| l.clamp(1, 1024)).unwrap_or(256)
}

fn offset(args: &Value) -> u64 {
    optional_u64(args, "offset").unwrap_or(0)
}

fn parse_cell_2d(args: &Value) -> Result<(i32, i32), BridgeError> {
    let coords = args
        .get("coords")
        .ok_or_else(|| BridgeError::InvalidArgs("'coords' is required".into()))?;
    parse_ivec2(coords, "coords")
}

fn parse_cell_3d(args: &Value) -> Result<(i32, i32, i32), BridgeError> {
    let coords = args
        .get("coords")
        .ok_or_else(|| BridgeError::InvalidArgs("'coords' is required".into()))?;
    parse_ivec3(coords, "coords")
}

fn parse_ivec2(value: &Value, name: &str) -> Result<(i32, i32), BridgeError> {
    if let Some(items) = value.as_array() {
        if items.len() == 2
            && let (Some(x), Some(y)) = (items[0].as_i64(), items[1].as_i64())
        {
            return Ok((x as i32, y as i32));
        }
    } else if let Some(obj) = value.as_object()
        && let (Some(x), Some(y)) =
            (obj.get("x").and_then(Value::as_i64), obj.get("y").and_then(Value::as_i64))
    {
        return Ok((x as i32, y as i32));
    }
    Err(BridgeError::InvalidArgs(format!("'{name}' must be [x, y] or {{x, y}} integers")))
}

fn parse_ivec3(value: &Value, name: &str) -> Result<(i32, i32, i32), BridgeError> {
    if let Some(items) = value.as_array() {
        if items.len() == 3
            && let (Some(x), Some(y), Some(z)) =
                (items[0].as_i64(), items[1].as_i64(), items[2].as_i64())
        {
            return Ok((x as i32, y as i32, z as i32));
        }
    } else if let Some(obj) = value.as_object()
        && let (Some(x), Some(y), Some(z)) = (
            obj.get("x").and_then(Value::as_i64),
            obj.get("y").and_then(Value::as_i64),
            obj.get("z").and_then(Value::as_i64),
        )
    {
        return Ok((x as i32, y as i32, z as i32));
    }
    Err(BridgeError::InvalidArgs(format!("'{name}' must be [x, y, z] or {{x, y, z}} integers")))
}

type Region2 = (i32, i32, i32, i32);
type Region3 = ((i32, i32, i32), (i32, i32, i32));

fn parse_region_2d(args: &Value) -> Result<Option<Region2>, BridgeError> {
    let Some(region) = args.get("region") else {
        return Ok(None);
    };
    let obj = region
        .as_object()
        .ok_or_else(|| BridgeError::InvalidArgs("'region' must be {x, y, w, h}".into()))?;
    let get = |key: &str| {
        obj.get(key)
            .and_then(Value::as_i64)
            .map(|n| n as i32)
            .ok_or_else(|| BridgeError::InvalidArgs(format!("'region.{key}' must be an integer")))
    };
    Ok(Some((get("x")?, get("y")?, get("w")?, get("h")?)))
}

fn parse_region_3d(args: &Value) -> Result<Option<Region3>, BridgeError> {
    let Some(region) = args.get("region") else {
        return Ok(None);
    };
    let position = region
        .get("position")
        .ok_or_else(|| BridgeError::InvalidArgs("'region.position' is required".into()))?;
    let size = region
        .get("size")
        .ok_or_else(|| BridgeError::InvalidArgs("'region.size' is required".into()))?;
    Ok(Some((parse_ivec3(position, "region.position")?, parse_ivec3(size, "region.size")?)))
}

fn cell_in_region_2d(cell: (i32, i32), region: Region2) -> bool {
    let (x, y, w, h) = region;
    cell.0 >= x && cell.0 < x + w && cell.1 >= y && cell.1 < y + h
}

fn cell_in_region_3d(cell: (i32, i32, i32), region: Region3) -> bool {
    let ((x, y, z), (w, h, d)) = region;
    cell.0 >= x && cell.0 < x + w && cell.1 >= y && cell.1 < y + h && cell.2 >= z && cell.2 < z + d
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ivec_parsers_accept_both_forms() {
        assert_eq!(parse_ivec2(&json!([2, 3]), "coords").unwrap(), (2, 3));
        assert_eq!(parse_ivec2(&json!({ "x": -1, "y": 5 }), "coords").unwrap(), (-1, 5));
        assert!(parse_ivec2(&json!([2.5, 3]), "coords").is_err());
        assert_eq!(parse_ivec3(&json!([1, 0, 2]), "coords").unwrap(), (1, 0, 2));
        assert_eq!(parse_ivec3(&json!({ "x": 1, "y": 0, "z": 2 }), "coords").unwrap(), (1, 0, 2));
        assert!(parse_ivec3(&json!([1, 0]), "coords").is_err());
    }

    #[test]
    fn region_filters_are_half_open() {
        let region = (0, 0, 4, 2);
        assert!(cell_in_region_2d((0, 0), region));
        assert!(cell_in_region_2d((3, 1), region));
        assert!(!cell_in_region_2d((4, 0), region));
        assert!(!cell_in_region_2d((0, 2), region));
        assert!(!cell_in_region_2d((-1, 0), region));

        let region = ((0, 0, 0), (2, 2, 2));
        assert!(cell_in_region_3d((1, 1, 1), region));
        assert!(!cell_in_region_3d((2, 0, 0), region));
        assert!(!cell_in_region_3d((0, 0, -1), region));
    }
}
