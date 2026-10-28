import importlib.util
import sys
import time

HERMES = "/home/kara/.hermes/hermes-agent"
if HERMES not in sys.path:
    sys.path.insert(0, HERMES)

spec = importlib.util.spec_from_file_location(
    "duckbrain_provider", "/home/kara/.hermes/plugins/duckbrain/__init__.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

p = mod.DuckBrainMemoryProvider()
print("name       :", p.name)
print("available  :", p.is_available())
p.initialize("smoke-20261028", agent_workspace="coding-hermes")
print("prompt blk :", p.system_prompt_block()[:120], "...")

q = "cooldown policy scheduler saturation"
p.queue_prefetch(q)
t0 = time.time()
while time.time() - t0 < 20:
    pack = p.prefetch(q)
    if pack:
        break
    time.sleep(0.25)
print(f"\nprefetch latency: {time.time() - t0:.2f}s")
print("pack chars:", len(pack))
print(pack[:700] if pack else "(EMPTY PACK)")

pc = p.on_pre_compress([])
print("\non_pre_compress chars:", len(pc))
print(pc[:200] if pc else "(empty)")
print("\nstats:", p.stats())

# fail-open check: point at a dead port
mod.DEFAULT_URL = "http://127.0.0.1:39999"
p2 = mod.DuckBrainMemoryProvider()
print("\nfail-open is_available (dead port):", p2.is_available())
p2.initialize("x", agent_workspace="coding-hermes")
t0 = time.time()
p2.queue_prefetch("anything")
time.sleep(1.0)
print("fail-open pack:", repr(p2.prefetch("anything")), f"({time.time()-t0:.2f}s, no raise)")
