# Build the Tern Isle tern in Blender and export it as models/tern.obj + tern.mtl.
# From the mod folder (mods/TernIsle):
#   Blender -b --factory-startup -P source/build_tern.py -- models [preview_dir]
# With a preview_dir it also renders five views of the model there (keep it
# out of models/: the build warns about images it does not read).
# Bones: the vertex groups are named after the bones of anims/tern.json
# (body, head, wing_l, wing_r, tail, leg_l, leg_r).
#
# Designed in model units (128 per tile = 128 per Blender metre after the 1/128 scale),
# Blender axes: x = the bird's left, -y = front (the bill), z = up. The OBJ exporter's
# default axes (forward -Z, up Y) turn that into what the Brumescape converter expects.
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
U = 1 / 128  # model units -> metres

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------------------------------------------------------- materials
COLOURS = {
    'tern_white': (0.93, 0.93, 0.92),
    'tern_grey': (0.66, 0.70, 0.76),
    'tern_tip': (0.30, 0.32, 0.36),
    'tern_cap': (0.06, 0.06, 0.07),
    'tern_bill': (0.86, 0.18, 0.10),
    'tern_leg': (0.80, 0.22, 0.14),
}
mats = {}
for name, rgb in COLOURS.items():
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1.0)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    mats[name] = m


# ---------------------------------------------------------------- mesh helpers
class Part:
    def __init__(self, name, smooth, dz=-5.0):
        self.name = name
        self.smooth = smooth
        self.dz = dz
        self.verts = []
        self.faces = []  # (indices, material)

    def v(self, x, y, z):
        z += self.dz
        self.verts.append((x * U, y * U, z * U))
        return len(self.verts) - 1

    def f(self, idx, mat):
        self.faces.append((list(idx), mat))


def ring(part, y, zc, rx, rz, sides=8, phase=0.0):
    return [part.v(rx * math.cos(phase + 2 * math.pi * i / sides), y, zc + rz * math.sin(phase + 2 * math.pi * i / sides)) for i in range(sides)]


def loft(part, rings, mat_for):
    # mat_for(ring_index, side_index, mid_z_of_quad) -> material
    for r in range(len(rings) - 1):
        a, b = rings[r], rings[r + 1]
        n = len(a)
        for i in range(n):
            j = (i + 1) % n
            quad = [a[i], a[j], b[j], b[i]]
            zmid = sum(part.verts[k][2] for k in quad) / 4 / U - part.dz
            part.f(quad, mat_for(r, i, zmid))


def cap(part, ring_idx, point, mat, reverse=False):
    tip = part.v(*point)
    n = len(ring_idx)
    for i in range(n):
        j = (i + 1) % n
        tri = [ring_idx[i], ring_idx[j], tip]
        part.f(tri[::-1] if reverse else tri, mat)


def slab(part, outline, thickness_axis, thickness, mat_top, mat_bottom=None, mat_edge=None):
    # Extrude a convex outline (list of (x,y,z) in units) by `thickness` along an axis into a closed prism.
    off = [0, 0, 0]
    off['xyz'.index(thickness_axis)] = thickness
    top = [part.v(*p) for p in outline]
    bot = [part.v(p[0] + off[0], p[1] + off[1], p[2] + off[2]) for p in outline]
    part.f(top, mat_top)
    part.f(bot[::-1], mat_bottom or mat_top)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        part.f([top[j], top[i], bot[i], bot[j]], mat_edge or mat_top)


parts = []

# ---------------------------------------------------------------- body (label 1)
body = Part('body', smooth=True)
rings = [ring(body, *spec) for spec in [(-15, 24.5, 4.5, 4.5), (-10, 21.5, 7, 7), (-2, 20, 8, 7.5), (8, 21, 6.5, 6), (16, 22.5, 3.5, 3.5)]]
# grey mantle on the back, white underneath
loft(body, rings, lambda r, i, z: 'tern_grey' if r >= 1 and z > 25.0 else 'tern_white')
cap(body, rings[0], (0, -17, 25.5), 'tern_white', reverse=True)
cap(body, rings[-1], (0, 21, 23), 'tern_white')
parts.append(body)

# ---------------------------------------------------------------- head + bill (label 2)
head = Part('head', smooth=True)
hr = [ring(head, *spec) for spec in [(-13, 26, 4, 4), (-19, 29, 4.6, 4.6), (-24, 31, 5, 5), (-28, 31, 3.6, 3.6)]]
# black cap over the top of the head, white throat and cheeks
loft(head, hr, lambda r, i, z: 'tern_cap' if z > 29.2 or (r == 2 and z > 28.5) else 'tern_white')
cap(head, hr[0], (0, -11, 25.5), 'tern_white', reverse=True)
cap(head, hr[-1], (0, -30.5, 31), 'tern_cap')
parts.append(head)

bill = Part('head', smooth=False)
b = [bill.v(-1.6, -27.0, 29.2), bill.v(1.6, -27.0, 29.2), bill.v(1.4, -27.0, 31.6), bill.v(-1.4, -27.0, 31.6)]
tip = bill.v(0, -41, 28.6)
bill.f([b[0], b[1], b[2], b[3]][::-1], 'tern_bill')
for i in range(4):
    bill.f([b[i], b[(i + 1) % 4], tip], 'tern_bill')
parts.append(bill)

# ---------------------------------------------------------------- folded wings (labels 3, 4)
def wing(name, side):
    # Folded wing lying on the flank and back, tilted about 45 degrees: an upper
    # (inner) edge along the back and a lower (outer) edge along the flank. The
    # outer surface is offset outward from the inner one by its thickness.
    w = Part(name, smooth=False)
    s = side
    inner = {
        'sh_u': (4.6, -9, 27.2), 'sh_l': (7.9, -8, 21.4),
        'wr_u': (4.6, 2, 27.8), 'wr_l': (8.7, 0, 19.4),
        'md_u': (3.6, 12, 26.7), 'md_l': (6.9, 12, 20.4),
        'tp_u': (2.6, 34, 25.6), 'tp_l': (3.8, 32, 24.0),
    }
    n = Vector((0.72, 0, 0.69))  # outward normal (left side)
    t = 1.3
    idx = {}
    for key, (x, y, z) in inner.items():
        idx[key + '_i'] = w.v(s * x, y, z)
        idx[key + '_o'] = w.v(s * (x + n.x * t), y, z + n.z * t)

    def face(keys, mat, outer):
        ids = [idx[k + ('_o' if outer else '_i')] for k in keys]
        if outer != (s > 0):
            ids = ids[::-1]
        w.f(ids, mat)

    coverts = ['sh_u', 'sh_l', 'wr_l', 'md_l', 'md_u', 'wr_u']
    primaries = ['md_u', 'md_l', 'tp_l', 'tp_u']
    for keys, mat in ((coverts, 'tern_grey'), (primaries, 'tern_tip')):
        face(keys, mat, True)
        face(keys, mat, False)
    # rim faces around the whole outline join the two surfaces
    outline = ['sh_u', 'sh_l', 'wr_l', 'md_l', 'tp_l', 'tp_u', 'md_u', 'wr_u']
    for a, b in zip(outline, outline[1:] + outline[:1]):
        ids = [idx[a + '_i'], idx[b + '_i'], idx[b + '_o'], idx[a + '_o']]
        w.f(ids if s > 0 else ids[::-1], 'tern_tip' if a in ('md_l', 'tp_l', 'tp_u') else 'tern_grey')
    return w


parts.append(wing('wing_l', 1))
parts.append(wing('wing_r', -1))

# ---------------------------------------------------------------- forked tail (label 5)
tail = Part('tail', smooth=False)
for s in (1, -1):
    streamer = [(0, 15, 23.5), (s * 3.2, 16, 23.6), (s * 7.2, 38, 25.2), (s * 1.0, 23, 23.8)]
    slab(tail, streamer if s > 0 else streamer[::-1], 'z', -0.8, 'tern_white')
parts.append(tail)

# ---------------------------------------------------------------- legs (labels 6, 7)
def leg(name, side):
    l = Part(name, smooth=False, dz=0.0)
    x = side * 3.0
    # a thin tapering leg from the belly to the ground
    top = [l.v(x - 0.9, 0.0, 10), l.v(x + 0.9, 0.0, 10), l.v(x + 0.9, 2.0, 10), l.v(x - 0.9, 2.0, 10)]
    bot = [l.v(x - 0.6, 0.4, 1.2), l.v(x + 0.6, 0.4, 1.2), l.v(x + 0.6, 1.6, 1.2), l.v(x - 0.6, 1.6, 1.2)]
    l.f(top, 'tern_leg')
    l.f(bot[::-1], 'tern_leg')
    for i in range(4):
        j = (i + 1) % 4
        l.f([top[j], top[i], bot[i], bot[j]], 'tern_leg')
    # webbed foot: a flat wedge on the ground, toes forward
    foot = [(x - 0.8, 2.2, 1.2), (x + 0.8, 2.2, 1.2), (x + 2.2, -4.0, 0.4), (x - 2.2, -4.0, 0.4)]
    slab(l, foot, 'z', -0.8, 'tern_leg')
    return l


parts.append(leg('leg_l', 1))
parts.append(leg('leg_r', -1))

# ---------------------------------------------------------------- build one object with vertex groups
mesh = bpy.data.meshes.new('tern')
obj = bpy.data.objects.new('tern', mesh)
scene.collection.objects.link(obj)
mat_names = list(COLOURS)
for name in mat_names:
    obj.data.materials.append(mats[name])

bm = bmesh.new()
deform = bm.verts.layers.deform.verify()
group_names = ['body', 'head', 'wing_l', 'wing_r', 'tail', 'leg_l', 'leg_r']
for g in group_names:
    obj.vertex_groups.new(name=g)
for part in parts:
    gi = group_names.index(part.name)
    bverts = []
    for co in part.verts:
        bv = bm.verts.new(co)
        bv[deform][gi] = 1.0
        bverts.append(bv)
    for idx, mat in part.faces:
        face = bm.faces.new([bverts[i] for i in idx])
        face.material_index = mat_names.index(mat)
        face.smooth = part.smooth
bm.normal_update()
# make every face point outward (each part is a closed shell)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bmesh.ops.triangulate(bm, faces=bm.faces)
bm.to_mesh(mesh)
bm.free()
print(f'tern: {len(mesh.vertices)} verts, {len(mesh.polygons)} tris')

# ---------------------------------------------------------------- export
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.wm.obj_export(
    filepath=os.path.join(out_dir, 'tern.obj'),
    export_selected_objects=True,
    forward_axis='NEGATIVE_Z',
    up_axis='Y',
    export_vertex_groups=True,
    export_materials=True,
    export_uv=False,
    export_normals=False,
    export_triangulated_mesh=True,
)

# ---------------------------------------------------------------- previews (Workbench, material colours)
if preview_dir is None:
    print('done')
    sys.exit(0)
os.makedirs(preview_dir, exist_ok=True)
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.show_cavity = False
scene.render.resolution_x = 640
scene.render.resolution_y = 480
scene.render.film_transparent = False
world = bpy.data.worlds.new('w')
scene.world = world
world.color = (0.55, 0.62, 0.70)
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 0.62
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
target = Vector((0, -0.0, 0.12))
views = {
    'three_quarter': Vector((-0.9, -1.0, 0.55)),
    'side': Vector((-1, 0, 0.05)),
    'front': Vector((0, -1, 0.1)),
    'top': Vector((0, 0.001, 1)),
    'back_quarter': Vector((0.8, 1.0, 0.6)),
}
for name, d in views.items():
    cam.location = target + d.normalized() * 2.0
    direction = target - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(preview_dir, f'preview_{name}.png')
    bpy.ops.render.render(write_still=True)
print('done')
