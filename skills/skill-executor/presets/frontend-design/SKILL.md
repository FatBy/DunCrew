---
name: frontend-design
description: "Apply visual design improvements to frontend applications. This skill helps enhance the UI/UX of web applications through styling, layout, and component improvements."
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "🎨"
    primaryEnv: "shell"
---

# Frontend Design

## Description
Apply visual design improvements to frontend applications. This skill helps enhance the UI/UX of web applications through styling, layout, and component improvements.

## Instructions

1. **Analyze Current Design**
   - Scan the project for frontend frameworks (React, Vue, Svelte, etc.)
   - Identify CSS framework in use (Tailwind, Bootstrap, styled-components, etc.)
   - Review existing color palette and typography
   - Note current component structure

2. **Identify Design Opportunities**
   - Check for inconsistent spacing/margins
   - Look for poor color contrast
   - Identify missing hover/focus states
   - Find areas lacking visual hierarchy
   - Note responsive design issues

3. **Apply Design Improvements**
   Based on the framework and style preference:

   **For Tailwind CSS:**
   - Use consistent spacing scale (p-4, m-6, gap-2)
   - Apply color themes via `bg-primary`, `text-secondary`
   - Add transitions: `transition-all duration-200`
   - Use shadows for elevation: `shadow-md hover:shadow-lg`

   **For CSS Modules / Vanilla CSS:**
   - Create CSS custom properties for colors
   - Define spacing variables
   - Add smooth transitions
   - Implement consistent border-radius

   **For styled-components:**
   - Create a theme object with design tokens
   - Use ThemeProvider for consistency
   - Define reusable styled primitives

4. **Enhance Components**
   - Add hover/active states to interactive elements
   - Improve button styling (padding, border-radius, shadows)
   - Enhance form inputs (focus rings, validation states)
   - Add loading states and skeletons
   - Improve card/container styling

5. **Verify Changes**
   - Check responsive behavior at different breakpoints
   - Verify color contrast meets WCAG standards
   - Test interactive states work correctly
   - Ensure animations are smooth (60fps)

## Examples

**Modern Minimal Style:**
- Clean white backgrounds with subtle shadows
- Rounded corners (8-12px)
- Sans-serif typography (Inter, SF Pro)
- Accent color for CTAs
- Generous whitespace

**Dark Mode Implementation:**
- Define dark color palette
- Add `dark:` variants in Tailwind
- Use CSS `prefers-color-scheme`
- Ensure sufficient contrast

## Notes

- Always preserve existing functionality
- Test in multiple browsers
- Consider accessibility (focus states, color contrast)
- Use CSS transitions for smooth state changes
- Keep design consistent across pages
