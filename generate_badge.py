import xml.etree.ElementTree as ET
import re

def create_badge_svg():
    src = 'frontend/icon.svg'
    dst = 'frontend/badge.svg'
    
    ET.register_namespace('', "http://www.w3.org/2000/svg")
    tree = ET.parse(src)
    root = tree.getroot()
    
    # Namespace handling
    ns = {'svg': 'http://www.w3.org/2000/svg'}
    
    # Remove gradients
    for tag in ['linearGradient', 'radialGradient', 'defs']:
        for el in root.findall(f'.//svg:{tag}', ns):
            root.remove(el)
            
    # Remove background shadows (ellipses at the bottom?)
    # The shadow ellipse was roughly cx="64" cy="113.9" and cy="84.05"
    # We'll filter based on fill color or attributes if possible, or just index.
    # Actually, let's keep the main shapes.
    
    # Strategy: Convert ALL visible shapes to white.
    # Remove anything that looks like a "shadow" (often low opacity or specific colors)
    # The file has `opacity=".18"` on one path - that's likely a shadow.
    
    to_remove = []
    
    for el in root.iter():
        # Strip namespace from tag for easier checking
        tag_name = el.tag.split('}')[-1]
        
        if tag_name in ['path', 'ellipse', 'circle', 'rect']:
            # Check for shadow indicators
            if el.get('opacity'):
                to_remove.append(el)
                continue
                
            # Set to white
            el.set('fill', '#FFFFFF')
            el.set('stroke', 'none')
            
            # Remove url references in fill (gradients)
            if 'url(' in str(el.get('fill')):
                 el.set('fill', '#FFFFFF')

    # Remove identified shadow elements
    # Note: removing from tree while iterating is tricky, but 'root.iter()' yields all.
    # We need to find the parent to remove. ET doesn't give parent pointers easily.
    # We'll rebuild or do a second pass?
    # Simpler: Set their 'display' to 'none'
    for el in to_remove:
        el.set('display', 'none')

    tree.write(dst)
    print(f"Created {dst}")

if __name__ == '__main__':
    create_badge_svg()
