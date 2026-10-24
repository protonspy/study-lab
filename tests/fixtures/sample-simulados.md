# Course: Sample Cloud Course — Simulados


## Storage Basics - Quiz (simple-quiz)

### Questão 1

A team needs durable storage for images that many web servers read. Which option fits best?

- **A)** A local disk on one server
- **B)** Object storage
- **C)** An in-memory cache only

<details><summary>Resposta</summary>

**Correta:** B

- A: A local disk is tied to one server and is not shared.
- B: Correct. Object storage is durable and shared by many readers.
- C: A cache is not durable storage.

</details>

### Questão 2

Which TWO practices reduce the blast radius of leaked credentials?

- **A)** Least privilege
- **B)** Sharing one admin user
- **C)** Short-lived credentials
- **D)** Disabling logs

<details><summary>Resposta</summary>

**Correta:** A, C

- A: Correct. Each identity can do only what it needs.
- B: A shared admin user widens the damage.
- C: Correct. Temporary credentials expire.
- D: Logs help detect misuse.

**Explicação:** Combine least privilege with temporary credentials.

</details>


## Final Practice Exam (practice-test)

### Questão 1 — Security

What does encryption at rest protect against?

- **A)** Stolen disks or snapshots
- **B)** Slow queries

<details><summary>Resposta</summary>

**Correta:** A

- A: Correct. Data on stolen media stays unreadable.
- B: Encryption does not change query speed.

</details>
