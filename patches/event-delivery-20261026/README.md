Owner: \src/core/event-store.ts\, \src/core/loop.ts\, \src/worlds/console/world.ts\ and \src/worlds/bilibili/\.

# Event delivery and history replay patches

Apply this ordered series to official Cortico commit `2c13db3e76ede19a4632925cb4aba6881afccebe` in a clean checkout:

```sh
git am /path/to/event-delivery-20261026/1-a2ec1c4.patch /path/to/event-delivery-20261026/2-8dfdf13.patch /path/to/event-delivery-20261026/3-3e89135.patch
```

The patches preserve Bilibili audience identities and interval semantics, archive delivery provenance, and make console history reads asynchronous and cancellable. They contain the implementation, tests and owning documentation.

The reconstructed source tree equals `7a0423027fdab4a53526580826f34f74382427c0`. It passed 5,071 tests (3 skipped) and type checking. This directory distributes the patches; the fork's older runtime source is unchanged. The series does not modify GitHub workflows. See manifest.json for source commits and SHA-256 hashes.
