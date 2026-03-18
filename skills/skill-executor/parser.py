#!/usr/bin/env python3
"""
SKILL.md Parser - Parses skill definition files.

SKILL.md Format:
```
---
name: skill-name
description: Brief description
version: 1.0.0
author: Author Name
tags: [tag1, tag2]
inputs:
  param1:
    type: string
    required: true
    description: Parameter description
outputs:
  result:
    type: object
---

# Skill Name

## Description
Detailed description of what the skill does.

## Instructions
Step-by-step instructions for the agent to follow.

1. First step
2. Second step
3. ...

## Examples
Example usage scenarios.

## Notes
Additional notes or constraints.
```
"""

import re
import yaml
from pathlib import Path
from typing import Dict, Any, Optional, List


class SkillParser:
    """Parser for SKILL.md files."""
    
    def __init__(self):
        self.frontmatter_pattern = re.compile(
            r'^---\s*\n(.*?)\n---\s*\n',
            re.DOTALL
        )
        self.section_pattern = re.compile(
            r'^##\s+(.+?)$\n(.*?)(?=^##|\Z)',
            re.MULTILINE | re.DOTALL
        )
    
    def parse(self, content: str) -> Dict[str, Any]:
        """
        Parse a SKILL.md file content.
        
        Args:
            content: SKILL.md file content
            
        Returns:
            Parsed skill definition
        """
        result = {
            'metadata': {},
            'description': '',
            'instructions': '',
            'examples': '',
            'notes': '',
            'raw_content': content
        }
        
        # Extract frontmatter
        frontmatter_match = self.frontmatter_pattern.match(content)
        if frontmatter_match:
            try:
                result['metadata'] = yaml.safe_load(frontmatter_match.group(1)) or {}
            except yaml.YAMLError:
                pass
            content = content[frontmatter_match.end():]
        
        # Extract title (# heading)
        title_match = re.match(r'^#\s+(.+?)$', content, re.MULTILINE)
        if title_match:
            result['title'] = title_match.group(1).strip()
        
        # Extract sections
        for section_match in self.section_pattern.finditer(content):
            section_name = section_match.group(1).strip().lower()
            section_content = section_match.group(2).strip()
            
            if section_name == 'description':
                result['description'] = section_content
            elif section_name == 'instructions':
                result['instructions'] = section_content
            elif section_name == 'examples':
                result['examples'] = section_content
            elif section_name == 'notes':
                result['notes'] = section_content
            else:
                # Store other sections
                result[section_name] = section_content
        
        # Use metadata description if not in body
        if not result['description'] and result['metadata'].get('description'):
            result['description'] = result['metadata']['description']
        
        return result
    
    def parse_file(self, file_path: str) -> Dict[str, Any]:
        """
        Parse a SKILL.md file.
        
        Args:
            file_path: Path to SKILL.md file
            
        Returns:
            Parsed skill definition
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"Skill file not found: {file_path}")
        
        content = path.read_text(encoding='utf-8')
        result = self.parse(content)
        result['file_path'] = str(path.absolute())
        
        # Infer name from filename if not in metadata
        if not result['metadata'].get('name'):
            result['metadata']['name'] = path.stem.replace('SKILL', '').strip('-').strip('_') or path.parent.name
        
        return result
    
    def validate(self, skill_def: Dict[str, Any]) -> List[str]:
        """
        Validate a parsed skill definition.
        
        Args:
            skill_def: Parsed skill definition
            
        Returns:
            List of validation errors (empty if valid)
        """
        errors = []
        
        metadata = skill_def.get('metadata', {})
        
        # Required fields
        if not metadata.get('name'):
            errors.append("Missing required field: name")
        
        if not skill_def.get('instructions'):
            errors.append("Missing Instructions section")
        
        # Validate inputs if present
        inputs = metadata.get('inputs', {})
        if inputs:
            for param_name, param_def in inputs.items():
                if not isinstance(param_def, dict):
                    errors.append(f"Invalid input definition for: {param_name}")
                    continue
                if not param_def.get('type'):
                    errors.append(f"Missing type for input: {param_name}")
        
        return errors


class SkillDiscovery:
    """Discovers skills from various locations."""
    
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.parser = SkillParser()
        
        # Skill locations (in priority order)
        self.builtin_dir = Path(__file__).parent / 'presets'
        self.custom_dir = self.project_root / '.duncrew' / 'skills'
        self.project_skills_dir = self.project_root / 'skills'
    
    def discover_all(
        self,
        include_builtin: bool = True,
        include_custom: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Discover all available skills.
        
        Returns:
            List of skill summaries
        """
        skills = []
        
        if include_builtin:
            skills.extend(self._discover_from_dir(self.builtin_dir, 'builtin'))
        
        if include_custom:
            skills.extend(self._discover_from_dir(self.custom_dir, 'custom'))
            skills.extend(self._discover_from_dir(self.project_skills_dir, 'project'))
        
        return skills
    
    def _discover_from_dir(self, directory: Path, source: str) -> List[Dict[str, Any]]:
        """Discover skills from a directory."""
        skills = []
        
        if not directory.exists():
            return skills
        
        # Look for SKILL.md files
        for skill_file in directory.glob('**/SKILL.md'):
            try:
                skill_def = self.parser.parse_file(str(skill_file))
                skills.append({
                    'name': skill_def['metadata'].get('name', skill_file.parent.name),
                    'description': skill_def.get('description', '')[:200],
                    'version': skill_def['metadata'].get('version', '1.0.0'),
                    'tags': skill_def['metadata'].get('tags', []),
                    'source': source,
                    'path': str(skill_file)
                })
            except Exception:
                continue
        
        return skills
    
    def find_skill(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Find a skill by name.
        Supports both kebab-case and snake_case names.
        
        Args:
            name: Skill name (e.g., 'general-task' or 'general_task')
            
        Returns:
            Full skill definition or None
        """
        # Generate name variants for matching
        alt_name = name.replace('_', '-')
        alt_name2 = name.replace('-', '_')
        name_variants = list(set([name, alt_name, alt_name2]))
        
        # Search in all locations
        for directory in [self.builtin_dir, self.custom_dir, self.project_skills_dir]:
            if not directory.exists():
                continue
            
            # Direct match with name variants
            for variant in name_variants:
                skill_file = directory / variant / 'SKILL.md'
                if skill_file.exists():
                    return self.parser.parse_file(str(skill_file))
            
            # Search subdirectories (match by metadata name or directory name)
            for candidate in directory.glob('**/SKILL.md'):
                try:
                    candidate_dir_name = candidate.parent.name
                    # Quick directory name check first
                    if candidate_dir_name in name_variants:
                        return self.parser.parse_file(str(candidate))
                    
                    # Full metadata check
                    skill_def = self.parser.parse_file(str(candidate))
                    meta_name = skill_def['metadata'].get('name', '')
                    if meta_name in name_variants:
                        return skill_def
                except Exception:
                    continue
        
        return None


if __name__ == '__main__':
    import json
    
    # Test parsing
    sample_skill = '''---
name: test-skill
description: A test skill
version: 1.0.0
inputs:
  message:
    type: string
    required: true
---

# Test Skill

## Description
This is a test skill for demonstration.

## Instructions
1. Print the message
2. Return success

## Examples
Use this skill to test the system.
'''
    
    parser = SkillParser()
    result = parser.parse(sample_skill)
    print(json.dumps(result, indent=2, default=str))
