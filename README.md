# Wompi SDK Monorepo

This is the monorepo for the **unofficial** Wompi SDK. The project consists of a monorepo created with [Turborepo](https://turbo.build/repo) and PNPM Workspaces.

## Installation

To install this monorepo, first clone the repository:

```bash
git clone https://github.com/pulgueta/wompi-sdk
```

Then, install the dependencies:

```bash
pnpm install
```

## Usage and Development

Within the monorepo, navigate to the packages inside the `packages/` folder. Each package has its own `README.md` with specific instructions and/or usage.

Package structure:

```plaintext
apps
└── docs
packages
├── core
└── ts
```

- `core`: Main package with the SDK logic.
- `ts`: Package with basic configurations for `tsconfig.json` files.
- `docs`: Documentation application with [Astro](https://astro.build/).

## Contributing

For contributions, read the [CONTRIBUTING.md](CONTRIBUTING.md) file.
