# Build the Mclabe olive oil models in Blender and export them as OBJ + MTL:
#   mclabe_oil_barrel  the big barrel in the Brimhaven bunkhouse (Danvid's)
#   mclabe_oil_bottle  Danvid's Olive Oil, the bottle the player fills from it
# From the mod folder (mods/MclabeCinematicUniverse):
#   Blender -b --factory-startup -P source/build_models.py -- models [preview_dir]
# With a preview_dir it also renders each model there (keep it out of models/:
# the build warns about images it does not read).
#
# Designed in model units (128 per Blender metre): x right, -y front, z up. A
# player is about 200 units tall. The barrel's staves use the mod's texture
# textures/mclabe_oil_texture.png (map_Kd), turned so the planks run upright.
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
out_dir = args[0]
preview_dir = args[1] if len(args) > 1 else None
os.makedirs(out_dir, exist_ok=True)
U = 1 / 128
MOD_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXTURE = os.path.join(MOD_DIR, 'textures', 'mclabe_oil_texture.png')

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, rgb, texture=None, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, alpha)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
    if texture:
        tex = m.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(texture)
        m.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return m


class Mesh:
    def __init__(self):
        self.verts = []
        self.faces = []  # (indices, material, uvs or None, smooth)

    def v(self, x, y, z):
        self.verts.append((x * U, y * U, z * U))
        return len(self.verts) - 1

    def f(self, idx, mat, uvs=None, smooth=False):
        self.faces.append((list(idx), mat, uvs, smooth))


def ring(mesh, z, r, sides):
    return [mesh.v(r * math.cos(2 * math.pi * i / sides), r * math.sin(2 * math.pi * i / sides), z) for i in range(sides)]


def band(mesh, a, b, mat, uv_rows=None, smooth=False):
    # quads between two rings (counter-clockwise seen from outside)
    n = len(a)
    for i in range(n):
        j = (i + 1) % n
        uvs = None
        if uv_rows:
            u0, u1 = uv_rows
            # u runs up the barrel, v across one stave: the texture's
            # horizontal planks become upright staves. The stave is a
            # trapezoid, so its narrower edge gets a v range inset by the
            # difference: the UVs match its shape (an affine map), and both
            # of its triangles share one texture mapping (a model has 64).
            wa = (Vector(mesh.verts[a[j]]) - Vector(mesh.verts[a[i]])).length
            wb = (Vector(mesh.verts[b[j]]) - Vector(mesh.verts[b[i]])).length
            wide = max(wa, wb)
            ia = (wide - wa) / 2 / wide
            ib = (wide - wb) / 2 / wide
            uvs = [(u0, ia), (u0, 1.0 - ia), (u1, 1.0 - ib), (u1, ib)]
        mesh.f([a[i], a[j], b[j], b[i]], mat, uvs, smooth)


def disc(mesh, r_idx, centre, mat, up=True):
    c = mesh.v(*centre)
    n = len(r_idx)
    for i in range(n):
        j = (i + 1) % n
        tri = [r_idx[i], r_idx[j], c] if up else [r_idx[j], r_idx[i], c]
        mesh.f(tri, mat)


def build(name, mesh, mats):
    me = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, me)
    scene.collection.objects.link(obj)
    names = list(mats)
    for n in names:
        me.materials.append(mats[n])
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    bverts = [bm.verts.new(co) for co in mesh.verts]
    for idx, mat, uvs, smooth in mesh.faces:
        face = bm.faces.new([bverts[i] for i in idx])
        face.material_index = names.index(mat)
        face.smooth = smooth
        if uvs:
            for loop, uv in zip(face.loops, uvs):
                loop[uv_layer].uv = uv
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    print(f'{name}: {len(me.vertices)} verts, {len(me.polygons)} tris')
    return obj


def export(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.obj_export(
        filepath=os.path.join(out_dir, f'{obj.name}.obj'),
        export_selected_objects=True,
        forward_axis='NEGATIVE_Z',
        up_axis='Y',
        export_materials=True,
        export_uv=True,
        export_normals=False,
        export_triangulated_mesh=True,
        path_mode='STRIP',
    )


# ---------------------------------------------------------------- the barrel
SIDES = 10
barrel_mats = {
    'mclabe_staves': material('mclabe_staves', (0.45, 0.28, 0.14), texture=TEXTURE),
    'mclabe_hoop': material('mclabe_hoop', (0.20, 0.20, 0.22)),
    'mclabe_wood_dark': material('mclabe_wood_dark', (0.26, 0.16, 0.08)),
    'mclabe_oil': material('mclabe_oil', (0.62, 0.55, 0.12)),
}
b = Mesh()
# outer staves: bulging in the middle, as barrels do
profile = [(0, 33), (14, 38), (48, 42), (82, 38), (96, 34)]
rings = [ring(b, z, r, SIDES) for z, r in profile]
for k in range(len(rings) - 1):
    band(b, rings[k], rings[k + 1], 'mclabe_staves', uv_rows=(k / (len(rings) - 1), (k + 1) / (len(rings) - 1)))
disc(b, rings[0], (0, 0, 0), 'mclabe_wood_dark', up=False)
# rim: the staves' thickness, then the inside down to the oil
inner_top = ring(b, 96, 31, SIDES)
band(b, rings[-1], inner_top, 'mclabe_wood_dark')
inner_oil = ring(b, 86, 32, SIDES)
band(b, inner_top, inner_oil, 'mclabe_wood_dark')
disc(b, inner_oil, (0, 0, 86), 'mclabe_oil')
# two iron hoops, just proud of the staves
for z0, z1, r0, r1 in ((12, 20, 38.6, 39.4), (76, 84, 39.4, 38.4)):
    lo, hi = ring(b, z0, r0, SIDES), ring(b, z1, r1, SIDES)
    band(b, lo, hi, 'mclabe_hoop')
barrel = build('mclabe_oil_barrel', b, barrel_mats)
export(barrel)

# ---------------------------------------------------------------- the bottle
bottle_mats = {
    'mclabe_bottle_oil': material('mclabe_bottle_oil', (0.66, 0.58, 0.14)),
    'mclabe_bottle_glass': material('mclabe_bottle_glass', (0.55, 0.62, 0.52)),
    'mclabe_cork': material('mclabe_cork', (0.48, 0.32, 0.18)),
}
t = Mesh()
SIDES = 8
bp = [(0, 7.5, 'mclabe_bottle_oil'), (17, 7.5, 'mclabe_bottle_glass'), (21, 3.2, 'mclabe_bottle_glass'), (26, 3.0, 'mclabe_cork'), (31, 3.0, None)]
brings = [ring(t, z, r, SIDES) for z, r, _ in bp]
for k in range(len(brings) - 1):
    band(t, brings[k], brings[k + 1], bp[k][2], smooth=True)
disc(t, brings[0], (0, 0, 0), 'mclabe_bottle_oil', up=False)
disc(t, brings[-1], (0, 0, 31), 'mclabe_cork')
bottle = build('mclabe_oil_bottle', t, bottle_mats)
# the bottle is an item: put it in its own scene position for the preview only
export(bottle)

# ---------------------------------------------------------------- previews
if preview_dir is None:
    print('done')
    sys.exit(0)
os.makedirs(preview_dir, exist_ok=True)
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'TEXTURE'
scene.render.resolution_x = 480
scene.render.resolution_y = 480
world = bpy.data.worlds.new('w')
scene.world = world
world.color = (0.55, 0.62, 0.70)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.type = 'ORTHO'
scene.collection.objects.link(cam)
scene.camera = cam
for obj, size, height in ((barrel, 1.0, 0.38), (bottle, 0.36, 0.12)):
    for other in (barrel, bottle):
        other.hide_render = other is not obj
    cam.data.ortho_scale = size
    target = Vector((0, 0, height))
    cam.location = target + Vector((-0.8, -1.0, 0.7)).normalized() * 3.0
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(preview_dir, f'preview_{obj.name}.png')
    bpy.ops.render.render(write_still=True)
print('done')
