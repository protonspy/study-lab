import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cosine } from "../src/main/embeddings"

/*
  The local embedding model. The download is checked against a scripted Hugging Face; the model
  itself runs only when STUDY_LAB_TEST_MODELS points at a models folder that already holds it
  (it is a 300 MB download), e.g. the app's own %APPDATA%/Study Lab/models.
*/

const realModels = process.env.STUDY_LAB_TEST_MODELS
const dir = mkdtempSync(join(tmpdir(), "study-lab-models-"))
process.env.STUDY_LAB_MODELS = realModels ?? dir
const local = await import("../src/main/localEmbed")
const realFetch = globalThis.fetch

after(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
})

describe("local embedding model", () => {
  it("refuses a download that does not match the pinned model and leaves nothing behind", { skip: !!realModels }, async () => {
    globalThis.fetch = (async () => new Response("not the model")) as typeof fetch
    await assert.rejects(local.downloadLocalModel(), /does not match the pinned model/)
    const s = local.localModelStatus()
    assert.equal(s.state, "failed")
    assert.ok(!existsSync(local.modelDir()) || readdirSync(local.modelDir()).length === 0)
    globalThis.fetch = realFetch
  })

  it("embeds on the CPU: paraphrases, also across languages, score above related concepts, which score above unrelated ones", { skip: !realModels }, async () => {
    assert.equal(local.localModelStatus().state, "ready")
    const [a, b, c, d, e] = await local.embedLocal([
      "Security groups are stateful firewalls at the instance level.",
      "Grupos de segurança são firewalls stateful no nível da instância.",
      "Network ACLs are stateless and operate at the subnet level.",
      "O Route 53 é o serviço de DNS da AWS.",
      "",
    ])
    assert.equal(a.length, 768)
    assert.ok(Math.abs(cosine(a, a) - 1) < 1e-3, "unit vectors")
    const same = cosine(a, b)
    const related = cosine(a, c)
    const unrelated = cosine(a, d)
    assert.ok(same > 0.88 && same > related && related > unrelated, `${same} ${related} ${unrelated}`)
    assert.equal(e.length, 768)
  })

  // STUDY_LAB_TEST_GPU picks the DirectML adapter (0 by default).
  const directml = !!realModels && process.platform === "win32"
  const texts = Array.from({ length: 80 }, (_, i) => `Concept ${i}: ${i % 2 ? "S3 lifecycle rules move objects between storage classes" : "Classes de armazenamento do S3 e regras de ciclo de vida"}.`)

  it("embeds on a GPU through DirectML the same vectors as on the CPU", { skip: !directml }, async () => {
    local.setLocalDevice("cpu", 0)
    const cpu = await local.embedLocal(texts)
    assert.equal(local.localModelStatus().speed?.device, "cpu")
    local.setLocalDevice("gpu", Number(process.env.STUDY_LAB_TEST_GPU ?? 0))
    const gpu = await local.embedLocal(texts)
    const s = local.localModelStatus()
    assert.equal(s.gpuError, undefined)
    assert.equal(s.speed?.device, "gpu")
    for (let i = 0; i < texts.length; i++) assert.ok(cosine(cpu[i], gpu[i]) > 0.999, `text ${i}: ${cosine(cpu[i], gpu[i])}`)
  })

  it("falls back to the CPU, saying why, when the GPU cannot run the model", { skip: !directml }, async () => {
    local.setLocalDevice("gpu", 99)
    const [v] = await local.embedLocal(texts)
    assert.equal(v.length, 768)
    const s = local.localModelStatus()
    assert.equal(s.device, "gpu")
    assert.ok(s.gpuError && !/dml_provider_factory/.test(s.gpuError), s.gpuError)
    assert.equal(s.speed?.device, "cpu")
    local.setLocalDevice("cpu", 0)
    assert.equal(local.localModelStatus().gpuError, undefined)
  })
})
