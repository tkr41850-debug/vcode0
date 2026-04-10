# orchestrator

Application service layer for driving the system.

This directory coordinates scheduler flow, feature lifecycle transitions, conflict handling, summary transitions, and other orchestration use cases on top of the core domain model and adapter-owned ports/contracts. It may depend on adapter interfaces and contract types, but not on concrete adapter implementations.
