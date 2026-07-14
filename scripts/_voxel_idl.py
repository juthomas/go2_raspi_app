"""Import VoxelMapCompressed_ from SDK or local fallback."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


def load_voxel_map_compressed_type() -> Any:
    try:
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import VoxelMapCompressed_

        return VoxelMapCompressed_
    except ImportError:
        scripts_dir = Path(__file__).resolve().parent
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        from idl.VoxelMapCompressed_ import VoxelMapCompressed_

        return VoxelMapCompressed_
