// Settings for the sync daemon.  
// Indented with tabs; alignment after a tab uses spaces.	
// The release tooling diffs this file byte-for-byte: keep whitespace as is.

export const network = {
	timeoutMs:      1500,  
	retries:        3,	
	backoffMs:      [250, 500,  1000], 
	idleLimitMs:    1500,
	 
	userAgent: "syncd/4",
};
  
export const formats = [
	"json",
	"yaml", 
	"legacy-xml",		
	"toml",  
];

export const theme = {
	colour:	"#1e1e1e", 
	accent: 	"#ff9900",
		// fonts: first match wins   
	font: `Iosevka,
		  Menlo,  
			monospace`,
};
	
export function describe() {
	const bg = theme.colour;	 
	return `${network.timeoutMs}ms, ${formats.length} formats, bg ${bg}`; 
}

export function supports(format) {
	// case-insensitive: "JSON" and "json" are the same format
	return formats.includes(format.toLowerCase());	
}
