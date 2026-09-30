"""Read an owned macOS process's NUL-delimited argv (and optionally environment).

Consumed through an anonymous pipe. Never write the environment to plans/logs.
"""
import ctypes
import json
import struct
import sys

pid = int(sys.argv[1])
if pid <= 0:
    raise ValueError('Invalid PID')
libc = ctypes.CDLL(None, use_errno=True)
libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN / KERN_PROCARGS2
size = ctypes.c_size_t()
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
    raise OSError(ctypes.get_errno(), 'Cannot inspect process arguments')
buffer = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
    raise OSError(ctypes.get_errno(), 'Cannot read process arguments')
data = bytes(buffer.raw[:size.value])
argc = struct.unpack_from('i', data)[0]
index = 4


def value():
    global index
    end = data.index(b'\0', index)
    result = data[index:end].decode('utf-8')
    index = end + 1
    return result


executable = value()
while index < len(data) and data[index] == 0:
    index += 1
argv = [value() for _ in range(argc)]
result = {'executable': executable, 'argv': argv}
if '--environment' in sys.argv[2:]:
    environment = {}
    while index < len(data) and data[index] != 0:
        entry = value()
        if '=' in entry:
            key, val = entry.split('=', 1)
            environment[key] = val
    result['env'] = environment
print(json.dumps(result))
