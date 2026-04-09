# src

Application entry and composition root.

This directory owns process startup, config loading, and wiring the concrete subsystems into the runnable gvc0 application. It should stay thin and avoid re-implementing subsystem logic.
