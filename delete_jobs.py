import json
with open('job_details_simple.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

data = [
    job for job in data
    if ('3-5年' not in job.get('工作经验', '') and
        '5-10年' not in job.get('工作经验', '') and 
        '硕士' not in job.get('学历要求', '') )
]

with open('job_details_simple.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=4)