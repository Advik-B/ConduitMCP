//! Tagged JSON <-> Variant conversion (whitepaper section 7.3).
//!
//! Godot's richer types are encoded as JSON objects carrying a `__type`
//! discriminator plus their constituent fields, so the bridge converts to and
//! from the correct `Variant` without guessing. Plain JSON scalars, arrays, and
//! untagged objects map to the obvious Variant kinds. Packed arrays accept the
//! tagged form on input and serialise as plain JSON arrays on output, never as
//! opaque strings.
//!
//! gdext `Variant` construction calls into the engine, so the conversions
//! themselves are exercised by the live integration eval, not `cargo test`. The
//! pure tag-parsing and field-extraction helpers below carry the validation and
//! error-message logic and are unit-tested here without Godot.

use godot::builtin::{
    Aabb, Basis, Color, GString, NodePath, PackedByteArray, PackedColorArray, PackedFloat32Array,
    PackedFloat64Array, PackedInt32Array, PackedInt64Array, PackedStringArray, PackedVector2Array,
    PackedVector3Array, Plane, Projection, Quaternion, Rect2, Rect2i, StringName, Transform2D,
    Rid, Transform3D, Vector2, Vector2i, Vector3, Vector3i, Vector4, Vector4i,
};
use godot::builtin::{Array as GArray, Dictionary, Variant, VariantType};
use godot::meta::ToGodot;
use godot::obj::{Gd, Singleton};
use serde_json::{json, Map, Value};

use crate::protocol::BridgeError;

/// The discriminator key that marks a tagged Godot type in JSON.
pub const TYPE_KEY: &str = "__type";

/// Return the `__type` discriminator if `value` is a tagged object.
pub fn type_tag(value: &Value) -> Option<&str> {
    value.as_object()?.get(TYPE_KEY)?.as_str()
}

fn invalid(message: impl Into<String>) -> BridgeError {
    BridgeError::InvalidArgs(message.into())
}

fn require_object<'a>(value: &'a Value, tag: &str) -> Result<&'a Map<String, Value>, BridgeError> {
    value.as_object().ok_or_else(|| invalid(format!("{tag} value must be an object")))
}

fn field<'a>(obj: &'a Map<String, Value>, tag: &str, key: &str) -> Result<&'a Value, BridgeError> {
    obj.get(key).ok_or_else(|| invalid(format!("{tag} is missing field '{key}'")))
}

fn field_f64(obj: &Map<String, Value>, tag: &str, key: &str) -> Result<f64, BridgeError> {
    field(obj, tag, key)?.as_f64().ok_or_else(|| invalid(format!("{tag}.{key} must be a number")))
}

fn field_f32(obj: &Map<String, Value>, tag: &str, key: &str) -> Result<f32, BridgeError> {
    Ok(field_f64(obj, tag, key)? as f32)
}

fn field_i64(obj: &Map<String, Value>, tag: &str, key: &str) -> Result<i64, BridgeError> {
    field(obj, tag, key)?.as_i64().ok_or_else(|| invalid(format!("{tag}.{key} must be an integer")))
}

fn field_i32(obj: &Map<String, Value>, tag: &str, key: &str) -> Result<i32, BridgeError> {
    Ok(field_i64(obj, tag, key)? as i32)
}

fn field_array<'a>(obj: &'a Map<String, Value>, tag: &str, key: &str) -> Result<&'a Vec<Value>, BridgeError> {
    field(obj, tag, key)?.as_array().ok_or_else(|| invalid(format!("{tag}.{key} must be an array")))
}

/// A [`Vector2`] given either as a tagged object, a two-element `[x, y]` array,
/// or a `{x, y}` object, so packed-array elements and plain input both work.
pub(crate) fn to_vector2(value: &Value) -> Result<Vector2, BridgeError> {
    if let Some(items) = value.as_array() {
        if items.len() != 2 {
            return Err(invalid("Vector2 array must have exactly 2 elements"));
        }
        let x = items[0].as_f64().ok_or_else(|| invalid("Vector2[0] must be a number"))? as f32;
        let y = items[1].as_f64().ok_or_else(|| invalid("Vector2[1] must be a number"))? as f32;
        return Ok(Vector2::new(x, y));
    }
    let obj = require_object(value, "Vector2")?;
    Ok(Vector2::new(field_f32(obj, "Vector2", "x")?, field_f32(obj, "Vector2", "y")?))
}

pub(crate) fn to_vector3(value: &Value) -> Result<Vector3, BridgeError> {
    if let Some(items) = value.as_array() {
        if items.len() != 3 {
            return Err(invalid("Vector3 array must have exactly 3 elements"));
        }
        let c = |i: usize| items[i].as_f64().map(|n| n as f32);
        return Ok(Vector3::new(
            c(0).ok_or_else(|| invalid("Vector3[0] must be a number"))?,
            c(1).ok_or_else(|| invalid("Vector3[1] must be a number"))?,
            c(2).ok_or_else(|| invalid("Vector3[2] must be a number"))?,
        ));
    }
    let obj = require_object(value, "Vector3")?;
    Ok(Vector3::new(
        field_f32(obj, "Vector3", "x")?,
        field_f32(obj, "Vector3", "y")?,
        field_f32(obj, "Vector3", "z")?,
    ))
}

pub(crate) fn to_color(value: &Value) -> Result<Color, BridgeError> {
    let obj = require_object(value, "Color")?;
    Ok(Color::from_rgba(
        field_f32(obj, "Color", "r")?,
        field_f32(obj, "Color", "g")?,
        field_f32(obj, "Color", "b")?,
        obj.get("a").and_then(Value::as_f64).map(|a| a as f32).unwrap_or(1.0),
    ))
}

pub(crate) fn to_vector4(value: &Value) -> Result<Vector4, BridgeError> {
    if let Some(items) = value.as_array() {
        if items.len() != 4 {
            return Err(invalid("Vector4 array must have exactly 4 elements"));
        }
        let c = |i: usize| items[i].as_f64().map(|n| n as f32);
        return Ok(Vector4::new(
            c(0).ok_or_else(|| invalid("Vector4[0] must be a number"))?,
            c(1).ok_or_else(|| invalid("Vector4[1] must be a number"))?,
            c(2).ok_or_else(|| invalid("Vector4[2] must be a number"))?,
            c(3).ok_or_else(|| invalid("Vector4[3] must be a number"))?,
        ));
    }
    let obj = require_object(value, "Vector4")?;
    Ok(Vector4::new(
        field_f32(obj, "Vector4", "x")?,
        field_f32(obj, "Vector4", "y")?,
        field_f32(obj, "Vector4", "z")?,
        field_f32(obj, "Vector4", "w")?,
    ))
}

/// A [`Quaternion`] given as a tagged object, `[x, y, z, w]` array, or
/// `{x, y, z, w}` object, mirroring the vector accept-forms.
pub(crate) fn to_quaternion(value: &Value) -> Result<Quaternion, BridgeError> {
    if let Some(items) = value.as_array() {
        if items.len() != 4 {
            return Err(invalid("Quaternion array must have exactly 4 elements"));
        }
        let c = |i: usize| items[i].as_f64().map(|n| n as f32);
        return Ok(Quaternion::new(
            c(0).ok_or_else(|| invalid("Quaternion[0] must be a number"))?,
            c(1).ok_or_else(|| invalid("Quaternion[1] must be a number"))?,
            c(2).ok_or_else(|| invalid("Quaternion[2] must be a number"))?,
            c(3).ok_or_else(|| invalid("Quaternion[3] must be a number"))?,
        ));
    }
    let obj = require_object(value, "Quaternion")?;
    Ok(Quaternion::new(
        field_f32(obj, "Quaternion", "x")?,
        field_f32(obj, "Quaternion", "y")?,
        field_f32(obj, "Quaternion", "z")?,
        field_f32(obj, "Quaternion", "w")?,
    ))
}

// The matrix and transform wire shapes use GDScript's property convention:
// Transform2D `x`/`y` and Basis/Projection `x`/`y`/`z`/`w` are the COLUMN
// vectors of the matrix. gdext stores Basis by rows, so input maps columns
// through `from_cols` and output reads them back through `col_a`/`col_b`/
// `col_c`. No flat element-array form is accepted, so row/column order can
// never be ambiguous on the wire.

fn to_transform2d(value: &Value) -> Result<Transform2D, BridgeError> {
    let obj = require_object(value, "Transform2D")?;
    Ok(Transform2D::from_cols(
        to_vector2(field(obj, "Transform2D", "x")?)?,
        to_vector2(field(obj, "Transform2D", "y")?)?,
        to_vector2(field(obj, "Transform2D", "origin")?)?,
    ))
}

fn to_basis(value: &Value) -> Result<Basis, BridgeError> {
    let obj = require_object(value, "Basis")?;
    Ok(Basis::from_cols(
        to_vector3(field(obj, "Basis", "x")?)?,
        to_vector3(field(obj, "Basis", "y")?)?,
        to_vector3(field(obj, "Basis", "z")?)?,
    ))
}

fn to_transform3d(value: &Value) -> Result<Transform3D, BridgeError> {
    let obj = require_object(value, "Transform3D")?;
    Ok(Transform3D::new(
        to_basis(field(obj, "Transform3D", "basis")?)?,
        to_vector3(field(obj, "Transform3D", "origin")?)?,
    ))
}

fn to_aabb(value: &Value) -> Result<Aabb, BridgeError> {
    let obj = require_object(value, "AABB")?;
    Ok(Aabb {
        position: to_vector3(field(obj, "AABB", "position")?)?,
        size: to_vector3(field(obj, "AABB", "size")?)?,
    })
}

// Every gdext Plane constructor asserts a unit normal; the struct literal is
// the documented non-panicking path and matches GDScript's Plane(a, b, c, d),
// which accepts any normal.
fn to_plane(value: &Value) -> Result<Plane, BridgeError> {
    let obj = require_object(value, "Plane")?;
    Ok(Plane {
        normal: to_vector3(field(obj, "Plane", "normal")?)?,
        d: field_f32(obj, "Plane", "d")?,
    })
}

fn to_projection(value: &Value) -> Result<Projection, BridgeError> {
    let obj = require_object(value, "Projection")?;
    Ok(Projection::from_cols(
        to_vector4(field(obj, "Projection", "x")?)?,
        to_vector4(field(obj, "Projection", "y")?)?,
        to_vector4(field(obj, "Projection", "z")?)?,
        to_vector4(field(obj, "Projection", "w")?)?,
    ))
}

/// Convert a JSON value into a Variant, coercing untagged JSON toward an
/// expected property type where the type is known from the node
/// (whitepaper section 7.3). The tagged form always wins, so an explicit
/// `__type` is honoured regardless of `expected`.
pub fn json_to_variant_typed(value: &Value, expected: VariantType) -> Result<Variant, BridgeError> {
    if type_tag(value).is_some() {
        return json_to_variant(value);
    }
    match expected {
        VariantType::VECTOR2 => Ok(to_vector2(value)?.to_variant()),
        VariantType::VECTOR3 => Ok(to_vector3(value)?.to_variant()),
        VariantType::VECTOR4 => Ok(to_vector4(value)?.to_variant()),
        VariantType::COLOR => Ok(to_color(value)?.to_variant()),
        VariantType::QUATERNION => Ok(to_quaternion(value)?.to_variant()),
        VariantType::TRANSFORM2D => Ok(to_transform2d(value)?.to_variant()),
        VariantType::BASIS => Ok(to_basis(value)?.to_variant()),
        VariantType::TRANSFORM3D => Ok(to_transform3d(value)?.to_variant()),
        VariantType::AABB => Ok(to_aabb(value)?.to_variant()),
        VariantType::PLANE => Ok(to_plane(value)?.to_variant()),
        VariantType::PROJECTION => Ok(to_projection(value)?.to_variant()),
        VariantType::FLOAT => value
            .as_f64()
            .map(|n| n.to_variant())
            .ok_or_else(|| invalid("expected a number for a float property")),
        VariantType::INT => value
            .as_i64()
            .map(|n| n.to_variant())
            .ok_or_else(|| invalid("expected an integer for an int property")),
        VariantType::BOOL => value
            .as_bool()
            .map(|b| b.to_variant())
            .ok_or_else(|| invalid("expected a boolean property value")),
        VariantType::STRING_NAME => value
            .as_str()
            .map(|s| StringName::from(s).to_variant())
            .ok_or_else(|| invalid("expected a string for a StringName property")),
        VariantType::NODE_PATH => value
            .as_str()
            .map(|s| NodePath::from(s).to_variant())
            .ok_or_else(|| invalid("expected a string for a NodePath property")),
        VariantType::RID => Ok(rid_from_json_id(value)?.to_variant()),
        _ => json_to_variant(value),
    }
}

/// Convert a JSON value into a Variant, honouring the `__type` discriminator.
pub fn json_to_variant(value: &Value) -> Result<Variant, BridgeError> {
    match value {
        Value::Null => Ok(Variant::nil()),
        Value::Bool(b) => Ok(b.to_variant()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.to_variant())
            } else {
                Ok(n.as_f64().unwrap_or(0.0).to_variant())
            }
        }
        Value::String(s) => Ok(GString::from(s.as_str()).to_variant()),
        Value::Array(items) => {
            let mut array = GArray::<Variant>::new();
            for item in items {
                array.push(&json_to_variant(item)?);
            }
            Ok(array.to_variant())
        }
        Value::Object(map) => match type_tag(value) {
            Some(tag) => tagged_to_variant(tag, map),
            None => {
                let mut dict = Dictionary::<Variant, Variant>::new();
                for (key, item) in map {
                    dict.set(&GString::from(key.as_str()), &json_to_variant(item)?);
                }
                Ok(dict.to_variant())
            }
        },
    }
}

fn tagged_to_variant(tag: &str, obj: &Map<String, Value>) -> Result<Variant, BridgeError> {
    let v = Value::Object(obj.clone());
    match tag {
        "Vector2" => Ok(to_vector2(&v)?.to_variant()),
        "Vector2i" => {
            Ok(Vector2i::new(field_i32(obj, tag, "x")?, field_i32(obj, tag, "y")?).to_variant())
        }
        "Vector3" => Ok(to_vector3(&v)?.to_variant()),
        "Vector3i" => Ok(Vector3i::new(
            field_i32(obj, tag, "x")?,
            field_i32(obj, tag, "y")?,
            field_i32(obj, tag, "z")?,
        )
        .to_variant()),
        "Vector4" => Ok(Vector4::new(
            field_f32(obj, tag, "x")?,
            field_f32(obj, tag, "y")?,
            field_f32(obj, tag, "z")?,
            field_f32(obj, tag, "w")?,
        )
        .to_variant()),
        "Vector4i" => Ok(Vector4i::new(
            field_i32(obj, tag, "x")?,
            field_i32(obj, tag, "y")?,
            field_i32(obj, tag, "z")?,
            field_i32(obj, tag, "w")?,
        )
        .to_variant()),
        "Color" => Ok(to_color(&v)?.to_variant()),
        "Quaternion" => Ok(to_quaternion(&v)?.to_variant()),
        "Rect2" => {
            let position = to_vector2(field(obj, tag, "position")?)?;
            let size = to_vector2(field(obj, tag, "size")?)?;
            Ok(Rect2::new(position, size).to_variant())
        }
        "Rect2i" => {
            let px = field_i32(obj, tag, "x")?;
            let py = field_i32(obj, tag, "y")?;
            let sw = field_i32(obj, tag, "w")?;
            let sh = field_i32(obj, tag, "h")?;
            Ok(Rect2i::new(Vector2i::new(px, py), Vector2i::new(sw, sh)).to_variant())
        }
        "PackedByteArray" => {
            let mut packed = PackedByteArray::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(item.as_i64().ok_or_else(|| invalid("PackedByteArray element must be an integer"))? as u8);
            }
            Ok(packed.to_variant())
        }
        "PackedInt32Array" => {
            let mut packed = PackedInt32Array::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(item.as_i64().ok_or_else(|| invalid("PackedInt32Array element must be an integer"))? as i32);
            }
            Ok(packed.to_variant())
        }
        "PackedInt64Array" => {
            let mut packed = PackedInt64Array::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(item.as_i64().ok_or_else(|| invalid("PackedInt64Array element must be an integer"))?);
            }
            Ok(packed.to_variant())
        }
        "PackedFloat32Array" => {
            let mut packed = PackedFloat32Array::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(item.as_f64().ok_or_else(|| invalid("PackedFloat32Array element must be a number"))? as f32);
            }
            Ok(packed.to_variant())
        }
        "PackedFloat64Array" => {
            let mut packed = PackedFloat64Array::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(item.as_f64().ok_or_else(|| invalid("PackedFloat64Array element must be a number"))?);
            }
            Ok(packed.to_variant())
        }
        "PackedStringArray" => {
            let mut packed = PackedStringArray::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(&GString::from(item.as_str().ok_or_else(|| invalid("PackedStringArray element must be a string"))?));
            }
            Ok(packed.to_variant())
        }
        "PackedVector2Array" => {
            let mut packed = PackedVector2Array::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(to_vector2(item)?);
            }
            Ok(packed.to_variant())
        }
        "PackedVector3Array" => {
            let mut packed = PackedVector3Array::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(to_vector3(item)?);
            }
            Ok(packed.to_variant())
        }
        "PackedColorArray" => {
            let mut packed = PackedColorArray::new();
            for item in field_array(obj, tag, "data")? {
                packed.push(to_color(item)?);
            }
            Ok(packed.to_variant())
        }
        "Resource" => {
            let path = field(obj, tag, "path")?
                .as_str()
                .ok_or_else(|| invalid("Resource.path must be a string"))?;
            validate_resource_path(path)?;
            godot::classes::ResourceLoader::singleton()
                .load(path)
                .map(|resource| resource.to_variant())
                .ok_or_else(|| BridgeError::ResourceError(format!("failed to load resource '{path}'")))
        }
        // A handle names an object this bridge process is already holding, so
        // a value handed back by a capture feeds straight into the next call as
        // an argument or a property value. Only `handle` is required; `class`
        // rides along for readability and is not checked, because the handle
        // table is the authority on what the object actually is.
        "Object" => {
            let handle = field(obj, tag, "handle")?;
            let id = match handle {
                Value::String(text) => crate::handles::parse_handle_id(text)?,
                Value::Number(number) => number.as_u64().ok_or_else(|| {
                    invalid("Object.handle must be a handle string or a positive integer")
                })?,
                _ => {
                    return Err(invalid("Object.handle must be a handle string or a positive integer"))
                }
            };
            Ok(crate::handles::resolve(id)?.to_variant())
        }
        // An RID is already a plain 64-bit value, so unlike an object it needs
        // no handle table: the id is the whole of it. Round-tripping one is
        // what lets the RenderingDevice and the physics servers be driven
        // through the generic verbs, since every step of those APIs both
        // returns and consumes RIDs.
        "RID" => Ok(rid_from_json_id(field(obj, tag, "id")?)?.to_variant()),
        "Transform2D" => Ok(to_transform2d(&v)?.to_variant()),
        "Basis" => Ok(to_basis(&v)?.to_variant()),
        "Transform3D" => Ok(to_transform3d(&v)?.to_variant()),
        "AABB" => Ok(to_aabb(&v)?.to_variant()),
        "Plane" => Ok(to_plane(&v)?.to_variant()),
        "Projection" => Ok(to_projection(&v)?.to_variant()),
        other => Err(invalid(format!("unsupported __type '{other}'"))),
    }
}

/// Read the `id` of a tagged RID from either the string or the number form.
///
/// The string form is what this bridge emits. An RID is a 64-bit value and the
/// broker's client is JavaScript, where `JSON.parse` silently rounds anything
/// above 2^53 -- so a numeric id would be corrupted before the bridge ever saw
/// it. The number form is still accepted on input, the way
/// `handles::parse_handle_id` accepts both `"object:3"` and `3`, because a
/// small id written by hand is unambiguous and refusing it would help nobody.
pub(crate) fn rid_from_json_id(value: &Value) -> Result<Rid, BridgeError> {
    let id = match value {
        Value::String(text) => text.trim().parse::<u64>().map_err(|_| {
            invalid(format!("RID.id '{text}' is not a 64-bit unsigned integer written as digits"))
        })?,
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| invalid("RID.id must be a non-negative integer"))?,
        _ => return Err(invalid("RID.id must be a decimal string or a non-negative integer")),
    };
    Ok(Rid::new(id))
}

/// Confine a tagged Resource path to the project or user directory
/// (whitepaper section 9). Sub-resource paths (`res://a.tscn::Sub_1`) pass.
pub(crate) fn validate_resource_path(path: &str) -> Result<(), BridgeError> {
    if !path.starts_with("res://") && !path.starts_with("user://") {
        return Err(invalid(format!("Resource path '{path}' must start with res:// or user://")));
    }
    if path.split('/').any(|segment| segment == "..") {
        return Err(invalid(format!("Resource path '{path}' must not contain '..' segments")));
    }
    Ok(())
}

/// Convert a Variant into JSON, tagging the richer types (section 7.3).
pub fn variant_to_json(variant: &Variant) -> Value {
    match variant.get_type() {
        VariantType::NIL => Value::Null,
        VariantType::BOOL => json!(variant.try_to::<bool>().unwrap_or(false)),
        VariantType::INT => json!(variant.try_to::<i64>().unwrap_or(0)),
        VariantType::FLOAT => json!(variant.try_to::<f64>().unwrap_or(0.0)),
        VariantType::STRING | VariantType::STRING_NAME | VariantType::NODE_PATH => {
            json!(variant.to_string())
        }
        VariantType::VECTOR2 => vector2_json(variant.try_to::<Vector2>().unwrap_or_default()),
        VariantType::VECTOR2I => {
            let v = variant.try_to::<Vector2i>().unwrap_or_default();
            json!({ TYPE_KEY: "Vector2i", "x": v.x, "y": v.y })
        }
        VariantType::VECTOR3 => vector3_json(variant.try_to::<Vector3>().unwrap_or_default()),
        VariantType::VECTOR3I => {
            let v = variant.try_to::<Vector3i>().unwrap_or_default();
            json!({ TYPE_KEY: "Vector3i", "x": v.x, "y": v.y, "z": v.z })
        }
        VariantType::VECTOR4 => vector4_json(variant.try_to::<Vector4>().unwrap_or_default()),
        VariantType::VECTOR4I => {
            let v = variant.try_to::<Vector4i>().unwrap_or_default();
            json!({ TYPE_KEY: "Vector4i", "x": v.x, "y": v.y, "z": v.z, "w": v.w })
        }
        VariantType::COLOR => {
            let c = variant.try_to::<Color>().unwrap_or(Color::from_rgba(0.0, 0.0, 0.0, 1.0));
            json!({ TYPE_KEY: "Color", "r": c.r, "g": c.g, "b": c.b, "a": c.a })
        }
        VariantType::QUATERNION => {
            let q = variant.try_to::<Quaternion>().unwrap_or_default();
            json!({ TYPE_KEY: "Quaternion", "x": q.x, "y": q.y, "z": q.z, "w": q.w })
        }
        VariantType::TRANSFORM2D => {
            transform2d_json(variant.try_to::<Transform2D>().unwrap_or_default())
        }
        VariantType::BASIS => basis_json(variant.try_to::<Basis>().unwrap_or_default()),
        VariantType::TRANSFORM3D => {
            let t = variant.try_to::<Transform3D>().unwrap_or_default();
            json!({ TYPE_KEY: "Transform3D", "basis": basis_json(t.basis), "origin": vector3_json(t.origin) })
        }
        VariantType::AABB => {
            let a = variant.try_to::<Aabb>().unwrap_or_default();
            json!({ TYPE_KEY: "AABB", "position": vector3_json(a.position), "size": vector3_json(a.size) })
        }
        VariantType::PLANE => {
            let p = variant
                .try_to::<Plane>()
                .unwrap_or(Plane { normal: Vector3::new(0.0, 0.0, 1.0), d: 0.0 });
            json!({ TYPE_KEY: "Plane", "normal": vector3_json(p.normal), "d": p.d })
        }
        VariantType::PROJECTION => {
            let p = variant.try_to::<Projection>().unwrap_or_default();
            json!({
                TYPE_KEY: "Projection",
                "x": vector4_json(p.cols[0]),
                "y": vector4_json(p.cols[1]),
                "z": vector4_json(p.cols[2]),
                "w": vector4_json(p.cols[3]),
            })
        }
        VariantType::RECT2 => {
            let r = variant.try_to::<Rect2>().unwrap_or_default();
            json!({ TYPE_KEY: "Rect2", "position": vector2_json(r.position), "size": vector2_json(r.size) })
        }
        VariantType::RECT2I => {
            let r = variant.try_to::<Rect2i>().unwrap_or_default();
            json!({ TYPE_KEY: "Rect2i", "x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y })
        }
        VariantType::ARRAY => {
            Value::Array(variant_array_items(variant).iter().map(variant_to_json).collect())
        }
        VariantType::DICTIONARY => {
            let mut map = Map::new();
            match variant.try_to::<Dictionary<Variant, Variant>>() {
                Ok(dict) => {
                    for (key, item) in dict.iter_shared() {
                        map.insert(key.to_string(), variant_to_json(&item));
                    }
                }
                // A typed Dictionary, for the reason variant_array_items gives.
                Err(_) => {
                    for key in variant_array_items(&variant.call("keys", &[])) {
                        let item = variant.call("get", &[key.clone(), Variant::nil()]);
                        map.insert(key.to_string(), variant_to_json(&item));
                    }
                }
            }
            Value::Object(map)
        }
        VariantType::PACKED_BYTE_ARRAY => {
            packed_json(variant.try_to::<PackedByteArray>().unwrap_or_default().as_slice(), |b| json!(*b))
        }
        VariantType::PACKED_INT32_ARRAY => {
            packed_json(variant.try_to::<PackedInt32Array>().unwrap_or_default().as_slice(), |n| json!(*n))
        }
        VariantType::PACKED_INT64_ARRAY => {
            packed_json(variant.try_to::<PackedInt64Array>().unwrap_or_default().as_slice(), |n| json!(*n))
        }
        VariantType::PACKED_FLOAT32_ARRAY => {
            packed_json(variant.try_to::<PackedFloat32Array>().unwrap_or_default().as_slice(), |n| json!(*n))
        }
        VariantType::PACKED_FLOAT64_ARRAY => {
            packed_json(variant.try_to::<PackedFloat64Array>().unwrap_or_default().as_slice(), |n| json!(*n))
        }
        VariantType::PACKED_STRING_ARRAY => {
            let packed = variant.try_to::<PackedStringArray>().unwrap_or_default();
            Value::Array(packed.to_vec().into_iter().map(|s| json!(s.to_string())).collect())
        }
        VariantType::PACKED_VECTOR2_ARRAY => {
            packed_json(variant.try_to::<PackedVector2Array>().unwrap_or_default().as_slice(), |v| vector2_json(*v))
        }
        VariantType::PACKED_VECTOR3_ARRAY => {
            packed_json(variant.try_to::<PackedVector3Array>().unwrap_or_default().as_slice(), |v| vector3_json(*v))
        }
        VariantType::PACKED_COLOR_ARRAY => {
            let packed = variant.try_to::<PackedColorArray>().unwrap_or_default();
            Value::Array(
                packed
                    .to_vec()
                    .into_iter()
                    .map(|c| json!({ TYPE_KEY: "Color", "r": c.r, "g": c.g, "b": c.b, "a": c.a }))
                    .collect(),
            )
        }
        // A resource-valued object encodes as its class and loadable path
        // (section 7.3); a pathless (unsaved) resource or non-resource object
        // falls back to stringification.
        VariantType::OBJECT => match variant.try_to::<Gd<godot::classes::Resource>>() {
            Ok(resource) => {
                let path = resource.get_path().to_string();
                if path.is_empty() {
                    json!(variant.to_string())
                } else {
                    json!({ TYPE_KEY: "Resource", "class": resource.get_class().to_string(), "path": path })
                }
            }
            Err(_) => json!(variant.to_string()),
        },
        VariantType::RID => {
            let rid = variant.try_to::<Rid>().unwrap_or(Rid::Invalid);
            json!({ TYPE_KEY: "RID", "id": rid.to_u64().to_string() })
        }
        // Remaining types (Callable, Signal) have no meaningful JSON form;
        // stringify rather than drop the value.
        _ => json!(variant.to_string()),
    }
}

/// The elements of an ARRAY variant, whether or not it carries an element type.
///
/// gdext refuses to convert a typed array (`Array[Node]`, `Array[String]`) into
/// the untyped `Array<Variant>`: `with_checked_type` compares the runtime
/// element type against the requested one and errors. Reading the elements
/// through the Variant's own method table is type-agnostic, and it is the
/// difference between reporting what is in the array and reporting `[]`, which
/// is what an `unwrap_or_default()` on that error used to do -- a wrong answer
/// rather than an error (`docs/api-gaps.md`). `size` and `get` exist on every
/// Array, so the calls cannot fail the way `Variant::call` panics on.
fn variant_array_items(variant: &Variant) -> Vec<Variant> {
    if let Ok(array) = variant.try_to::<GArray<Variant>>() {
        return array.iter_shared().collect();
    }
    if variant.get_type() != VariantType::ARRAY {
        return Vec::new();
    }
    let length = variant.call("size", &[]).try_to::<i64>().unwrap_or(0).max(0);
    (0..length).map(|index| variant.call("get", &[index.to_variant()])).collect()
}

pub(crate) fn vector2_json(v: Vector2) -> Value {
    json!({ TYPE_KEY: "Vector2", "x": v.x, "y": v.y })
}

pub(crate) fn vector3_json(v: Vector3) -> Value {
    json!({ TYPE_KEY: "Vector3", "x": v.x, "y": v.y, "z": v.z })
}

pub(crate) fn vector4_json(v: Vector4) -> Value {
    json!({ TYPE_KEY: "Vector4", "x": v.x, "y": v.y, "z": v.z, "w": v.w })
}

fn transform2d_json(t: Transform2D) -> Value {
    json!({
        TYPE_KEY: "Transform2D",
        "x": vector2_json(t.a),
        "y": vector2_json(t.b),
        "origin": vector2_json(t.origin),
    })
}

fn basis_json(b: Basis) -> Value {
    json!({
        TYPE_KEY: "Basis",
        "x": vector3_json(b.col_a()),
        "y": vector3_json(b.col_b()),
        "z": vector3_json(b.col_c()),
    })
}

fn packed_json<T>(items: &[T], to_value: impl Fn(&T) -> Value) -> Value {
    Value::Array(items.iter().map(to_value).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn type_tag_reads_discriminator() {
        assert_eq!(type_tag(&json!({ "__type": "Vector2", "x": 1, "y": 2 })), Some("Vector2"));
        assert_eq!(type_tag(&json!({ "x": 1 })), None);
        assert_eq!(type_tag(&json!([1, 2])), None);
        assert_eq!(type_tag(&json!("plain")), None);
    }

    #[test]
    fn a_rid_id_reads_from_a_string_or_a_number() {
        // Engine-free: parsing the id happens before any Variant is built.
        assert_eq!(rid_from_json_id(&json!("458912960610304")).unwrap().to_u64(), 458_912_960_610_304);
        assert_eq!(rid_from_json_id(&json!(" 7 ")).unwrap().to_u64(), 7);
        assert_eq!(rid_from_json_id(&json!(7)).unwrap().to_u64(), 7);
        assert!(rid_from_json_id(&json!(0)).unwrap().is_invalid());
    }

    #[test]
    fn a_rid_id_survives_above_two_to_the_fifty_third() {
        // The reason the id is carried as a string: this value is exact here
        // and would not survive a JSON number through the broker's client.
        let huge = u64::MAX - 1;
        assert!(huge > (1_u64 << 53));
        assert_eq!(rid_from_json_id(&json!(huge.to_string())).unwrap().to_u64(), huge);
    }

    #[test]
    fn a_malformed_rid_id_is_rejected() {
        assert_eq!(rid_from_json_id(&json!("nope")).unwrap_err().code(), "invalid_args");
        assert_eq!(rid_from_json_id(&json!(-1)).unwrap_err().code(), "invalid_args");
        assert_eq!(rid_from_json_id(&json!(1.5)).unwrap_err().code(), "invalid_args");
        assert_eq!(rid_from_json_id(&json!([1])).unwrap_err().code(), "invalid_args");
        let missing = json_to_variant(&json!({ "__type": "RID" })).unwrap_err();
        assert_eq!(missing.code(), "invalid_args");
    }

    #[test]
    fn an_object_tag_needs_a_handle_and_rejects_a_malformed_one() {
        // Engine-free: both of these fail while parsing the tagged form, before
        // the handle table is consulted and long before a Variant exists.
        let missing = json_to_variant(&json!({ "__type": "Object", "class": "SurfaceTool" })).unwrap_err();
        assert_eq!(missing.code(), "invalid_args");
        let malformed = json_to_variant(&json!({ "__type": "Object", "handle": "not-a-handle" })).unwrap_err();
        assert_eq!(malformed.code(), "invalid_args");
        let wrong_kind = json_to_variant(&json!({ "__type": "Object", "handle": [3] })).unwrap_err();
        assert_eq!(wrong_kind.code(), "invalid_args");
    }

    #[test]
    fn an_unminted_object_handle_is_object_not_found() {
        let absent = json_to_variant(&json!({ "__type": "Object", "handle": "object:912345" })).unwrap_err();
        assert_eq!(absent.code(), "object_not_found");
    }

    #[test]
    fn field_helpers_extract_and_report() {
        let obj = json!({ "x": 1.5, "y": 2, "name": "p" });
        let map = obj.as_object().unwrap();
        assert_eq!(field_f32(map, "Vector2", "x").unwrap(), 1.5);
        assert_eq!(field_i32(map, "Vector2i", "y").unwrap(), 2);

        let missing = field_f64(map, "Vector2", "z").unwrap_err();
        assert_eq!(missing.code(), "invalid_args");
        assert!(missing.to_string().contains("missing field 'z'"));

        let wrong = field_i64(map, "Vector2i", "name").unwrap_err();
        assert!(wrong.to_string().contains("must be an integer"));
    }

    #[test]
    fn field_array_requires_array() {
        let obj = json!({ "data": [1, 2, 3], "bad": 7 });
        let map = obj.as_object().unwrap();
        assert_eq!(field_array(map, "PackedInt32Array", "data").unwrap().len(), 3);
        assert!(field_array(map, "PackedInt32Array", "bad").is_err());
    }

    #[test]
    fn validate_resource_path_confines_to_the_project() {
        assert!(validate_resource_path("res://textures/wood.png").is_ok());
        assert!(validate_resource_path("res://main.tscn::Texture_a1").is_ok());
        assert!(validate_resource_path("user://cache.res").is_ok());
        assert_eq!(validate_resource_path("/etc/passwd").unwrap_err().code(), "invalid_args");
        assert_eq!(validate_resource_path("res://../outside.tres").unwrap_err().code(), "invalid_args");
        assert_eq!(validate_resource_path("C:/Windows/system.ini").unwrap_err().code(), "invalid_args");
    }

    #[test]
    fn to_vector4_accepts_all_forms() {
        let expected = Vector4::new(1.0, 2.0, 3.0, 4.0);
        assert_eq!(to_vector4(&json!([1, 2, 3, 4])).unwrap(), expected);
        assert_eq!(to_vector4(&json!({ "x": 1, "y": 2, "z": 3, "w": 4 })).unwrap(), expected);
        assert_eq!(
            to_vector4(&json!({ "__type": "Vector4", "x": 1, "y": 2, "z": 3, "w": 4 })).unwrap(),
            expected
        );
        assert!(to_vector4(&json!([1, 2, 3])).is_err());
        assert!(to_vector4(&json!({ "x": 1, "y": 2, "z": 3 })).unwrap_err().to_string().contains("'w'"));
    }

    // The wire format's x/y/z are column vectors; gdext stores rows. This test
    // pins the mapping so it cannot silently drift.
    #[test]
    fn basis_wire_columns_map_to_gdext_rows() {
        let b = to_basis(&json!({
            "x": [1, 2, 3],
            "y": [4, 5, 6],
            "z": [7, 8, 9],
        }))
        .unwrap();
        assert_eq!(b, Basis::from_cols(
            Vector3::new(1.0, 2.0, 3.0),
            Vector3::new(4.0, 5.0, 6.0),
            Vector3::new(7.0, 8.0, 9.0),
        ));
        assert_eq!(b.rows[0], Vector3::new(1.0, 4.0, 7.0));
        assert_eq!(b.rows[1], Vector3::new(2.0, 5.0, 8.0));
        assert_eq!(b.rows[2], Vector3::new(3.0, 6.0, 9.0));

        let out = basis_json(b);
        assert_eq!(out["x"]["x"], json!(1.0));
        assert_eq!(out["x"]["z"], json!(3.0));
        assert_eq!(out["z"]["x"], json!(7.0));
        assert_eq!(to_basis(&out).unwrap(), b);
    }

    #[test]
    fn transform2d_accepts_nested_vector_forms_and_round_trips() {
        let t = to_transform2d(&json!({
            "x": [0, 1],
            "y": { "x": -1, "y": 0 },
            "origin": { "__type": "Vector2", "x": 5, "y": 7 },
        }))
        .unwrap();
        assert_eq!(t.a, Vector2::new(0.0, 1.0));
        assert_eq!(t.b, Vector2::new(-1.0, 0.0));
        assert_eq!(t.origin, Vector2::new(5.0, 7.0));

        let out = transform2d_json(t);
        assert_eq!(out[TYPE_KEY], json!("Transform2D"));
        assert_eq!(to_transform2d(&out).unwrap(), t);

        let missing = to_transform2d(&json!({ "x": [0, 1], "y": [1, 0] })).unwrap_err();
        assert!(missing.to_string().contains("'origin'"));
    }

    #[test]
    fn transform3d_accepts_tagged_and_bare_basis() {
        let bare = to_transform3d(&json!({
            "basis": { "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1] },
            "origin": [10, 20, 30],
        }))
        .unwrap();
        let tagged = to_transform3d(&json!({
            "basis": { "__type": "Basis", "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1] },
            "origin": { "x": 10, "y": 20, "z": 30 },
        }))
        .unwrap();
        assert_eq!(bare, tagged);
        assert_eq!(bare.origin, Vector3::new(10.0, 20.0, 30.0));
    }

    #[test]
    fn aabb_reads_position_and_size() {
        let a = to_aabb(&json!({ "position": [1, 2, 3], "size": [4, 5, 6] })).unwrap();
        assert_eq!(a.position, Vector3::new(1.0, 2.0, 3.0));
        assert_eq!(a.size, Vector3::new(4.0, 5.0, 6.0));
    }

    #[test]
    fn plane_accepts_non_unit_normal_without_panicking() {
        let p = to_plane(&json!({ "normal": [0, 10, 0], "d": 2.5 })).unwrap();
        assert_eq!(p.normal, Vector3::new(0.0, 10.0, 0.0));
        assert_eq!(p.d, 2.5);
    }

    #[test]
    fn projection_wire_columns_round_trip() {
        let source = json!({
            "x": [1, 2, 3, 4],
            "y": [5, 6, 7, 8],
            "z": [9, 10, 11, 12],
            "w": [13, 14, 15, 16],
        });
        let p = to_projection(&source).unwrap();
        assert_eq!(p.cols[0], Vector4::new(1.0, 2.0, 3.0, 4.0));
        assert_eq!(p.cols[3], Vector4::new(13.0, 14.0, 15.0, 16.0));
    }
}
