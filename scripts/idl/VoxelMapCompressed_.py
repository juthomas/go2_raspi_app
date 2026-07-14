"""
VoxelMapCompressed_ — local fallback when unitree_sdk2py omits this type.

Fields match go2_interfaces/msg/VoxelMapCompressed.msg (Unitree utlidar voxel topic).
"""

from dataclasses import dataclass

import cyclonedds.idl as idl
import cyclonedds.idl.annotations as annotate
import cyclonedds.idl.types as types


@dataclass
@annotate.final
@annotate.autoid("sequential")
class VoxelMapCompressed_(idl.IdlStruct, typename="unitree_go.msg.dds_.VoxelMapCompressed_"):
    stamp: types.float64
    frame_id: str
    resolution: types.float64
    origin: types.array[types.float64, 3]
    width: types.array[types.int16, 3]
    src_size: types.uint64
    data: types.sequence[types.uint8]
