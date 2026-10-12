"""TinySkyNet (ONNX) in ein schlankes Format für src/skynet.ts umwandeln.

Quelle: https://github.com/kisakutanaka/SkySegmentation, models/tinyskynet_skyseg_256.onnx
(MIT, siehe public/models/LICENSE-TinySkyNet.txt). Aufruf:
  python3 scripts/export-skynet.py tinyskynet_skyseg_256.onnx public/models
Ergebnis: skynet.json (Graph: Faltung, ReLU, Größenänderung, Verketten) und skynet.bin
(Gewichte, float32 little endian).
"""
import json
import sys

import numpy as np
import onnx
from onnx import numpy_helper

src, out = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
inits = {i.name: numpy_helper.to_array(i).astype('<f4') for i in g.initializer}
consts = {}
blob = bytearray()
weights = {}


def add(name):
    if name in weights:
        return
    arr = inits[name]
    weights[name] = {'offset': len(blob) // 4, 'shape': list(arr.shape)}
    blob.extend(arr.tobytes())


nodes = []
for n in g.node:
    attrs = {a.name: onnx.helper.get_attribute_value(a) for a in n.attribute}
    if n.op_type == 'Constant':
        consts[n.output[0]] = numpy_helper.to_array(attrs['value']).tolist()
        continue
    node = {'op': n.op_type, 'in': [i for i in n.input if i], 'out': n.output[0]}
    if n.op_type == 'Conv':
        for w in n.input[1:]:
            add(w)
        node['in'] = [n.input[0]]
        node['w'] = n.input[1]
        node['b'] = n.input[2] if len(n.input) > 2 else None
        node['group'] = attrs.get('group', 1)
        node['stride'] = attrs['strides'][0]
        node['pad'] = attrs['pads'][0]
        node['k'] = attrs['kernel_shape'][0]
    elif n.op_type == 'Resize':
        assert attrs['mode'] == b'linear' and attrs['coordinate_transformation_mode'] == b'half_pixel'
        scales = consts[n.input[2]]
        assert scales[2] == scales[3] == 2
        node['in'] = [n.input[0]]
        node['scale'] = 2
    elif n.op_type == 'Concat':
        assert attrs['axis'] == 1
    elif n.op_type != 'Relu':
        raise SystemExit(f'nicht unterstützt: {n.op_type}')
    nodes.append(node)

json.dump({'input': g.input[0].name, 'output': g.output[0].name, 'nodes': nodes, 'weights': weights},
          open(f'{out}/skynet.json', 'w'), separators=(',', ':'))
open(f'{out}/skynet.bin', 'wb').write(blob)
print(len(nodes), 'Knoten,', len(blob) // 1024, 'KB Gewichte')
