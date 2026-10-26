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
})
