"""Draw original geometric PNG icons with Python's standard library."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent


def draw(name, color):
    scale, size = 4, 128
    pixels = bytearray(size*scale*size*scale*4)
    def point(x, y):
        if 0 <= x < size*scale and 0 <= y < size*scale:
            offset = (y*size*scale+x)*4
            pixels[offset:offset+4] = bytes((*color,255))
    def line(a,b,width=5):
        ax,ay=[v*scale for v in a];bx,by=[v*scale for v in b];r=width*scale/2
        for y in range(max(0,int(min(ay,by)-r)),min(size*scale,int(max(ay,by)+r+1))):
            for x in range(max(0,int(min(ax,bx)-r)),min(size*scale,int(max(ax,bx)+r+1))):
                length=(bx-ax)**2+(by-ay)**2
                t=max(0,min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/length)) if length else 0
                if (x-ax-t*(bx-ax))**2+(y-ay-t*(by-ay))**2 <= r*r:point(x,y)
    def path(points,closed=False,width=5):
        for a,b in zip(points,points[1:]+([points[0]] if closed else [])):line(a,b,width)
    def ellipse(cx,cy,rx,ry,start=0,end=2*math.pi,width=5):
        points=[(cx+rx*math.cos(start+(end-start)*i/96),cy+ry*math.sin(start+(end-start)*i/96)) for i in range(97)]
        path(points,width=width)
    if name in ('opened','workflow'):
        path([(39,27),(96,27),(96,76)],width=5)
        path([(27,40),(83,40),(83,97),(27,97)],True)
        line((40,55),(68,55),4)
    elif name=='bookmark':
        path([(64+38*math.cos(-math.pi/2+i*math.pi/5) if i%2==0 else 64+17*math.cos(-math.pi/2+i*math.pi/5),
               65+38*math.sin(-math.pi/2+i*math.pi/5) if i%2==0 else 65+17*math.sin(-math.pi/2+i*math.pi/5)) for i in range(10)],True)
    elif name=='history':
        ellipse(64,64,35,35);path([(64,43),(64,65),(81,76)])
    elif name=='url':
        ellipse(64,64,36,36);ellipse(64,64,17,36,width=4);line((30,52),(98,52),4);line((30,76),(98,76),4)
    elif name=='search':
        ellipse(57,56,26,26);line((77,77),(101,101),7)
    elif name=='new-tab':
        line((64,30),(64,98));line((30,64),(98,64))
    elif name=='warning':
        path([(64,27),(103,97),(25,97)],True);line((64,51),(64,72));line((64,85),(64,86),6)
    output=bytearray()
    for y in range(size):
        output.append(0)
        for x in range(size):
            alpha=sum(pixels[((y*scale+dy)*size*scale+x*scale+dx)*4+3] for dy in range(scale) for dx in range(scale))//(scale*scale)
            output.extend((*(color if alpha else (0,0,0)),alpha))
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(output),9))+chunk(b'IEND',b'')


def generate(output=None):
    output=Path(output or ROOT/'result-icons');output.mkdir(parents=True,exist_ok=True)
    colors={'opened':(45,157,120),'bookmark':(185,135,38),'history':(139,112,196),
            'url':(57,137,214),'search':(65,159,173),'new-tab':(105,128,149),
            'warning':(199,109,70),'workflow':(57,137,214)}
    for name,color in colors.items():(output/(name+'.png')).write_bytes(draw(name,color))


if __name__=='__main__':generate()
