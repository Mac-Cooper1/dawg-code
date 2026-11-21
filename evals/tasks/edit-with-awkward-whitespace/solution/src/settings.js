// Settings for the sync daemon.  
// Indented with tabs; alignment after a tab uses spaces.	
// The release tooling diffs this file byte-for-byte: keep whitespace as is.

export const network = {
	timeoutMs:      2500,  
	retries:        3,	
	backoffMs:      [250, 500,  1000], 
	idleLimitMs:    1500,
	 
	userAgent: "syncd/4",
};
  
export const formats = [
	"json",
	"yaml", 
	"toml",  
];

export const theme = {
	color:	"#1e1e1e", 
	accent: 	"#ff9900",
		// fonts: first match wins   
	font: `Iosevka,
		  Menlo,  
			monospace`,
};
	
export function describe() {
	const bg = theme.color;	 
	return `${network.timeoutMs}ms, ${formats.length} formats, bg ${bg}`; 
}

export function supports(format) {
	// case-insensitive: "JSON" and "json" are the same format
	return formats.includes(format.toLowerCase());	
}
