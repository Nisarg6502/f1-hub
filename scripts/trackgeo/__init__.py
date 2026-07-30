"""Offline track-geometry build for the 3D Elevation Track feature.

Turns openly-licensed circuit centrelines plus an open DEM into the baked,
quantised JSON the Three.js viewer loads from frontend/public/tracks/.

Run via scripts/build_track_geometry.py — see scripts/README.md for the data
sources, the OpenTopoData quota rules, and why the DEM query set is deliberately
decoupled from every smoothing parameter.
"""
