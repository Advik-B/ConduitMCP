extends Node2D

# Phase 8 eval fixture. Resources with hazardous text formats (TileSet,
# MeshLibrary, AnimationLibrary, skeleton bones, state machines) are built
# here in _ready instead of being hand-authored in scene text.

var last_touch := Vector2.ZERO
var touch_active := false
var last_gesture := ""
var gesture_value := 0.0


func echo(v):
	return v


func _ready() -> void:
	_build_animation()
	_build_animation_tree()
	_build_tileset()
	_build_gridmap_library()
	_build_skeleton()
	_build_nav_region()
	_build_speaker()
	_build_audio_bus()


func _input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		last_touch = event.position
		touch_active = event.pressed
	elif event is InputEventScreenDrag:
		last_touch = event.position
	elif event is InputEventMagnifyGesture:
		last_gesture = "magnify"
		gesture_value = event.factor
	elif event is InputEventPanGesture:
		last_gesture = "pan"
		gesture_value = event.delta.length()


func _build_animation() -> void:
	var animation := Animation.new()
	animation.length = 0.5
	var track := animation.add_track(Animation.TYPE_VALUE)
	animation.track_set_path(track, NodePath("Target:position"))
	animation.track_insert_key(track, 0.0, Vector2.ZERO)
	animation.track_insert_key(track, 0.5, Vector2(100, 0))
	var library := AnimationLibrary.new()
	library.add_animation("pulse", animation)
	$Anim.add_animation_library("", library)


# The tree starts inactive so it does not take over the AnimationPlayer
# during the player checks; the eval activates it before the travel check.
func _build_animation_tree() -> void:
	var machine := AnimationNodeStateMachine.new()
	var state := AnimationNodeAnimation.new()
	state.animation = "pulse"
	machine.add_node("pulse", state)
	var tree: AnimationTree = $Tree
	tree.anim_player = NodePath("../Anim")
	tree.tree_root = machine
	tree.active = false


func _build_tileset() -> void:
	var texture := PlaceholderTexture2D.new()
	texture.size = Vector2(16, 16)
	var source := TileSetAtlasSource.new()
	source.texture = texture
	source.texture_region_size = Vector2i(16, 16)
	source.create_tile(Vector2i.ZERO)
	var tiles := TileSet.new()
	tiles.add_source(source, 0)
	$Tiles.tile_set = tiles


func _build_gridmap_library() -> void:
	var library := MeshLibrary.new()
	library.create_item(0)
	library.set_item_name(0, "block")
	library.set_item_mesh(0, BoxMesh.new())
	$World3D/Grid.mesh_library = library


func _build_skeleton() -> void:
	var skeleton: Skeleton3D = $World3D/Bones
	skeleton.add_bone("root_bone")


func _build_nav_region() -> void:
	var polygon := NavigationPolygon.new()
	polygon.add_outline(PackedVector2Array([
		Vector2(0, 0), Vector2(100, 0), Vector2(100, 100), Vector2(0, 100),
	]))
	$NavRegion.navigation_polygon = polygon


func _build_speaker() -> void:
	$Speaker.stream = AudioStreamGenerator.new()


func _build_audio_bus() -> void:
	if AudioServer.get_bus_index("Phase8Fx") == -1:
		AudioServer.add_bus()
		var index := AudioServer.get_bus_count() - 1
		AudioServer.set_bus_name(index, "Phase8Fx")
		AudioServer.set_bus_volume_db(index, -3.0)
