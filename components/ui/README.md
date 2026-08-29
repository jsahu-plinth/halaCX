# HalaCX UI components

Untitled UI React is the default source for component structure, interaction behavior, and icons. HalaCX adapts those components to its product tokens in `app/globals.css`.

- Use `Button`, `Badge`, and `Card` from this directory instead of recreating controls.
- Use `@untitledui/icons` as the only product icon family.
- Use React Aria Components for keyboard and accessibility behavior.
- Controls use an 8px radius; panels use a 16px radius.
- Feature code may add product composition, but should not create another primitive library.
