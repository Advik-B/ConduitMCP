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
    Color, GString, PackedByteArray, PackedColorArray, PackedFloat32Array, PackedFloat64Array,
    PackedInt32Array, PackedInt64Array, PackedStringArray, PackedVector2Array, PackedVector3Array,
    Quaternion, Rect2, Rect2i, Vector2, Vector2i, Vector3, Vector3i, Vector4, Vector4i,
};
use godot::builtin::{Array as GArray, Dictionary, Variant, VariantType};
use godot::meta::ToGodot;
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
fn to_vector2(value: &Value) -> Result<Vector2, BridgeError> {
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

fn to_vector3(value: &Value) -> Result<Vector3, BridgeError> {
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

fn to_color(value: &Value) -> Result<Color, BridgeError> {
    let obj = require_object(value, "Color")?;
    Ok(Color::from_rgba(
        field_f32(obj, "Color", "r")?,
        field_f32(obj, "Color", "g")?,
        field_f32(obj, "Color", "b")?,
        obj.get("a").and_then(Value::as_f64).map(|a| a as f32).unwrap_or(1.0),
    ))
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
        "Quaternion" => Ok(Quaternion::new(
            field_f32(obj, tag, "x")?,
            field_f32(obj, tag, "y")?,
            field_f32(obj, tag, "z")?,
            field_f32(obj, tag, "w")?,
        )
        .to_variant()),
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
        other => Err(invalid(format!(
            "unsupported __type '{other}'; matrix and transform types are not yet tagged (see docs/api-gaps.md)"
        ))),
    }
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
        VariantType::VECTOR4 => {
            let v = variant.try_to::<Vector4>().unwrap_or_default();
            json!({ TYPE_KEY: "Vector4", "x": v.x, "y": v.y, "z": v.z, "w": v.w })
        }
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
        VariantType::RECT2 => {
            let r = variant.try_to::<Rect2>().unwrap_or_default();
            json!({ TYPE_KEY: "Rect2", "position": vector2_json(r.position), "size": vector2_json(r.size) })
        }
        VariantType::RECT2I => {
            let r = variant.try_to::<Rect2i>().unwrap_or_default();
            json!({ TYPE_KEY: "Rect2i", "x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y })
        }
        VariantType::ARRAY => {
            let array = variant.try_to::<GArray<Variant>>().unwrap_or_default();
            Value::Array(array.iter_shared().map(|item| variant_to_json(&item)).collect())
        }
        VariantType::DICTIONARY => {
            let dict = variant.try_to::<Dictionary<Variant, Variant>>().unwrap_or_default();
            let mut map = Map::new();
            for (key, item) in dict.iter_shared() {
                map.insert(key.to_string(), variant_to_json(&item));
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
        // Matrix, transform, and engine-object types have no tagged form yet;
        // stringify rather than drop the value (recorded in docs/api-gaps.md).
        _ => json!(variant.to_string()),
    }
}

fn vector2_json(v: Vector2) -> Value {
    json!({ TYPE_KEY: "Vector2", "x": v.x, "y": v.y })
}

fn vector3_json(v: Vector3) -> Value {
    json!({ TYPE_KEY: "Vector3", "x": v.x, "y": v.y, "z": v.z })
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
}
